"""FastAPI app — REST + WebSocket.

Only this service writes to Postgres. The dashboard reads through here and
subscribes to /ws for the live event stream.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import pathlib
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .core import CLOCK, HUB, close_db, db, emit
from . import injector
from .scenarios import EVENT_TYPES, SCENARIOS, list_scenarios
from .solver import solve_for_production_order

SEED_PATH = pathlib.Path(__file__).resolve().parents[2] / "supabase" / "seed.sql"

app = FastAPI(title="Supply Chain Disruption Control Agent", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)


@app.on_event("shutdown")
async def _shutdown() -> None:
    await injector.stop_all()
    await close_db()


# --------------------------------------------------------------- models ----


class CustomEvent(BaseModel):
    type: str
    params: dict[str, Any] = {}
    incident_id: str | None = None


class ManualLog(BaseModel):
    """Free-text note typed into the dashboard. Lands in the same audit stream."""
    text: str
    incident_id: str | None = None
    actor: str = "human"


# --------------------------------------------------------------- health ----


@app.get("/api/health")
async def health():
    pool = await db()
    async with pool.acquire() as conn:
        n = await conn.fetchval("select count(*) from suppliers")
    return {"ok": True, "suppliers": n, "clock": CLOCK.state(),
            "ws_clients": HUB.count, "running_scenarios": injector.running()}


@app.get("/api/clock")
async def clock_state():
    return CLOCK.state()


@app.post("/api/clock/rate")
async def clock_rate(seconds_per_sim_hour: float):
    if seconds_per_sim_hour <= 0:
        raise HTTPException(400, "must be > 0")
    CLOCK.seconds_per_sim_hour = seconds_per_sim_hour
    return CLOCK.state()


# ------------------------------------------------------------ scenarios ----


@app.get("/api/scenarios")
async def scenarios():
    return {"scenarios": list_scenarios(), "running": injector.running(),
            "event_types": EVENT_TYPES}


@app.get("/api/scenarios/{scenario_id}")
async def scenario_detail(scenario_id: str):
    if scenario_id not in SCENARIOS:
        raise HTTPException(404, "unknown scenario")
    return SCENARIOS[scenario_id]


@app.post("/api/scenarios/{scenario_id}/inject")
async def inject(scenario_id: str):
    try:
        return await injector.inject(scenario_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/events/custom")
async def custom_event(ev: CustomEvent):
    """Hand-craft a disruption from the dashboard. Same code path as scenarios."""
    if ev.type not in EVENT_TYPES:
        raise HTTPException(400, f"unknown type. one of: {', '.join(EVENT_TYPES)}")
    pool = await db()
    try:
        async with pool.acquire() as conn:
            return await injector.apply_event(conn, ev.type, ev.params, ev.incident_id)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/logs")
async def manual_log(entry: ManualLog):
    """Type a note in the dashboard; it becomes a first-class audit event."""
    pool = await db()
    async with pool.acquire() as conn:
        return await emit(conn, incident_id=entry.incident_id, actor=entry.actor,
                          event_type="MANUAL_NOTE", human_summary=entry.text,
                          payload={"source": "dashboard"})


@app.post("/api/scenarios/reset")
async def reset():
    """Re-seed from supabase/seed.sql. Under two seconds, fully idempotent."""
    await injector.stop_all()
    if not SEED_PATH.exists():
        raise HTTPException(500, f"seed file not found at {SEED_PATH}")
    sql = SEED_PATH.read_text(encoding="utf-8")
    pool = await db()
    async with pool.acquire() as conn:
        await conn.execute(sql)
    CLOCK.reset()
    await HUB.broadcast({"kind": "world_reset", "clock": CLOCK.state()})
    return {"ok": True, "clock": CLOCK.state()}


# ------------------------------------------------------------ operations ---


@app.get("/api/incidents")
async def incidents():
    pool = await db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """select i.*, c.name as component_name
                 from incidents i left join components c on c.id = i.component_id
                order by i.opened_at desc limit 100""")
    return {"incidents": [dict(r) for r in rows]}


@app.get("/api/audit")
async def audit(incident_id: str | None = None, after: int = 0, limit: int = 300):
    pool = await db()
    async with pool.acquire() as conn:
        if incident_id:
            rows = await conn.fetch(
                """select * from audit_events
                    where incident_id=$1 and sequence > $2
                    order by sequence limit $3""", incident_id, after, limit)
        else:
            rows = await conn.fetch(
                """select * from audit_events where sequence > $1
                    order by sequence limit $2""", after, limit)
    out = []
    for r in rows:
        d = dict(r)
        d["technical_payload"] = json.loads(d["technical_payload"]) \
            if isinstance(d["technical_payload"], str) else d["technical_payload"]
        out.append(d)
    return {"events": out}


@app.get("/api/world")
async def world():
    """Everything the dashboard needs for the operational panes, in one call."""
    pool = await db()
    async with pool.acquire() as conn:
        inv = await conn.fetch(
            """select i.*, c.name, c.is_hazmat,
                      round(i.usable_stock::numeric / nullif(i.daily_usage,0), 1) as coverage_days
                 from inventory i join components c on c.id = i.component_id
                order by coverage_days nulls last""")
        pos = await conn.fetch(
            """select p.*, t.supplier_claim, t.tracking_status
                 from purchase_orders p
                 left join shipment_tracking t on t.po_id = p.id
                order by p.expected_delivery""")
        prod = await conn.fetch("select * from production_orders order by deadline")
        sup = await conn.fetch(
            """select s.*, m.derived_reliability, m.contradictions_detected,
                      m.quality_failures, m.avg_delay_days
                 from suppliers s left join supplier_memory m on m.supplier_id = s.id
                order by m.derived_reliability desc nulls last""")
    return {
        "clock": CLOCK.state(),
        "inventory": [dict(r) for r in inv],
        "purchase_orders": [dict(r) for r in pos],
        "production_orders": [dict(r) for r in prod],
        "suppliers": [dict(r) for r in sup],
    }


@app.get("/api/solve/{production_order_id}")
async def solve_endpoint(production_order_id: str, record: bool = False):
    """Run the deterministic solver. `record=true` writes the reasoning to audit."""
    pool = await db()
    async with pool.acquire() as conn:
        try:
            result = await solve_for_production_order(conn, production_order_id)
        except ValueError as e:
            raise HTTPException(404, str(e))

        if record:
            iid = await conn.fetchval(
                "select id from incidents where component_id=$1 "
                "and status not in ('resolved','failed') order by opened_at desc limit 1",
                result.get("context", {}).get("component_id"))
            for rej in result["rejections"]:
                await emit(conn, incident_id=iid, actor="solver",
                           event_type="OPTION_REJECTED",
                           human_summary=rej["human_reason"],
                           payload={"supplier_id": rej["supplier_id"],
                                    "constraint": rej["constraint"], **rej["detail"]})
            chosen = result.get("chosen")
            if chosen:
                await emit(conn, incident_id=iid, actor="solver",
                           event_type="OPTION_SELECTED",
                           human_summary=f"Selected: {chosen['label']} — "
                                         f"Rs {chosen['total_cost']:,.0f}, "
                                         f"score {chosen['score']}.",
                           payload=chosen)
                if chosen["requires_approval"]:
                    await emit(conn, incident_id=iid, actor="solver",
                               event_type="APPROVAL_REQUIRED",
                               human_summary=f"Rs {chosen['total_cost']:,.0f} exceeds the "
                                             f"Rs {result['approval_threshold']:,} "
                                             f"autonomous threshold. Halting for a human.",
                               payload={"estimated_cost": chosen["total_cost"],
                                        "threshold": result["approval_threshold"]})
    return result


# ------------------------------------------------------------- websocket ---


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await HUB.connect(ws)
    await ws.send_text(json.dumps({"kind": "hello", "clock": CLOCK.state()}))

    async def heartbeat():
        while True:
            await asyncio.sleep(2)
            await ws.send_text(json.dumps({"kind": "clock", "clock": CLOCK.state()}))

    hb = asyncio.create_task(heartbeat())
    try:
        while True:
            await ws.receive_text()          # client keepalive; content ignored
    except WebSocketDisconnect:
        pass
    finally:
        hb.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await hb
        await HUB.disconnect(ws)
