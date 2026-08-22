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

from .core import (APPROVAL_THRESHOLD_INR, CLOCK, HUB, close_db, db, emit,
                    set_run_context)
from . import injector
from .scenarios import EVENT_TYPES, SCENARIOS, list_scenarios
from .solver import solve_for_production_order
from .scorer import score_run

SEED_PATH = pathlib.Path(__file__).resolve().parents[2] / "supabase" / "seed.sql"

app = FastAPI(title="Supply Chain Disruption Control Agent", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    # Any localhost port: 5173 is `vite dev`, 4173 is `vite preview`, and
    # teammates run on whatever port is free. This is a local dev tool.
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
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
async def reset(mode: str = "demo"):
    """Re-seed operational state.

    mode=demo (default) : operational tables only. Run history — scenario_runs,
                          run_scores, audit_events — is PRESERVED, so you keep
                          the comparisons you are tuning against.
    mode=hard           : also wipes history. Use between dev sessions, never
                          mid-tuning and never on demo day.
    """
    if mode not in ("demo", "hard"):
        raise HTTPException(400, "mode must be 'demo' or 'hard'")
    await injector.stop_all()
    if not SEED_PATH.exists():
        raise HTTPException(500, f"seed file not found at {SEED_PATH}")
    sql = SEED_PATH.read_text(encoding="utf-8")
    pool = await db()
    async with pool.acquire() as conn:
        await conn.execute(
            "update scenario_runs set status='reset', finished_at=now() "
            "where status='running'")
        await conn.execute(sql)
        if mode == "hard":
            await conn.execute(
                "truncate run_scores, scenario_runs, audit_events restart identity cascade")
    set_run_context(None)
    CLOCK.reset()
    await HUB.broadcast({"kind": "world_reset", "mode": mode, "clock": CLOCK.state()})
    return {"ok": True, "mode": mode,
            "history_preserved": mode == "demo", "clock": CLOCK.state()}


@app.get("/api/runs")
async def runs():
    pool = await db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """select r.*, s.total, s.continuity, s.cost, s.risk,
                      s.tool_eff, s.recovery, s.audit,
                      (select count(*) from audit_events a where a.scenario_run_id = r.id)
                        as event_count
                 from scenario_runs r
                 left join run_scores s on s.run_id = r.id
                order by r.started_at desc limit 50""")
    return {"runs": [dict(r) for r in rows]}


@app.post("/api/runs/{run_id}/score")
async def score(run_id: int):
    pool = await db()
    async with pool.acquire() as conn:
        try:
            return await score_run(conn, run_id)
        except ValueError as e:
            raise HTTPException(404, str(e))


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
async def audit(incident_id: str | None = None, run_id: int | None = None,
                after: int = 0, limit: int = 300):
    pool = await db()
    async with pool.acquire() as conn:
        if run_id is not None:
            rows = await conn.fetch(
                """select * from audit_events
                    where scenario_run_id=$1 and sequence > $2
                    order by sequence limit $3""", run_id, after, limit)
        elif incident_id:
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


@app.get("/api/kpis")
async def kpis():
    """Headline numbers for the overview strip."""
    pool = await db()
    async with pool.acquire() as conn:
        open_incidents = await conn.fetchval(
            "select count(*) from incidents where status not in ('resolved','failed')")
        critical = await conn.fetchval(
            "select count(*) from incidents where severity in ('high','critical') "
            "and status not in ('resolved','failed')")
        min_cover = await conn.fetchval(
            "select min(usable_stock::numeric / nullif(daily_usage,0)) from inventory")
        erp_gap = await conn.fetchval(
            "select coalesce(sum(erp_stock - usable_stock),0) from inventory")
        delayed = await conn.fetchval(
            "select count(*) from purchase_orders where status='delayed'")
        contradictions = await conn.fetchval(
            "select coalesce(sum(contradictions_detected),0) from supplier_memory")
        spend = await conn.fetchval(
            "select coalesce(sum(total_value),0) from purchase_orders where created_by_agent")
        rejects = await conn.fetch(
            "select technical_payload->>'constraint' as c, count(*) as n from audit_events "
            "where event_type='OPTION_REJECTED' group by 1")
        trust = await conn.fetchrow(
            "select round(avg(effective_reliability),3) as avg_trust, "
            "min(effective_reliability) as worst from supplier_effective")
        spark = await conn.fetch(
            "select date_trunc('minute', ts) as t, count(*) as n from audit_events "
            "group by 1 order by 1 desc limit 20")
    return {
        "open_incidents": open_incidents, "critical_incidents": critical,
        "min_coverage_days": float(min_cover or 0),
        "erp_gap_units": int(erp_gap or 0),
        "delayed_pos": delayed,
        "contradictions_caught": int(contradictions or 0),
        "agent_spend_inr": float(spend or 0),
        "approval_threshold": APPROVAL_THRESHOLD_INR,
        "constraints_enforced": {r["c"]: r["n"] for r in rejects if r["c"]},
        "avg_trust": float(trust["avg_trust"] or 0),
        "worst_trust": float(trust["worst"] or 0),
        "activity": [{"t": r["t"].isoformat(), "n": r["n"]} for r in reversed(spark)],
    }


@app.get("/api/network")
async def network():
    """Supplier -> plant graph for the flow view. Geography, not a map engine."""
    pool = await db()
    async with pool.acquire() as conn:
        plant = await conn.fetchrow(
            "select id, name, city, lat, lng from warehouses where id='Pune-Plant-1'")
        sup = await conn.fetch(
            """select s.id, s.name, s.city, s.country, s.lat, s.lng,
                      se.effective_reliability, se.contradictions_detected,
                      array_agg(distinct l.mode::text) as modes,
                      min(l.transit_days) as transit_days,
                      array_agg(distinct sc.component_id) as components
                 from suppliers s
                 join supplier_effective se on se.supplier_id = s.id
                 left join supplier_lanes l on l.supplier_id = s.id
                 left join supplier_catalog sc on sc.supplier_id = s.id
                group by s.id, s.name, s.city, s.country, s.lat, s.lng,
                         se.effective_reliability, se.contradictions_detected""")
        shipments = await conn.fetch(
            """select p.id, p.supplier_id, p.component_id, p.status::text as status,
                      p.mode::text as mode, p.quantity, p.total_value,
                      p.expected_delivery, t.supplier_claim, t.tracking_status
                 from purchase_orders p
                 left join shipment_tracking t on t.po_id = p.id
                where p.status in ('open','in_transit','delayed')""")
    now = CLOCK.now()
    ships = []
    for r in shipments:
        contradiction = (r["supplier_claim"] in ("dispatched", "in_transit")
                         and r["tracking_status"] in ("label_created_no_pickup", "not_shipped"))
        hrs = (r["expected_delivery"] - now).total_seconds() / 3600
        ships.append({**dict(r), "contradiction": contradiction,
                      "hours_to_eta": round(hrs, 1),
                      "progress": max(0.05, min(0.95, 1 - (hrs / 240)))})
    return {"plant": dict(plant) if plant else None,
            "suppliers": [dict(r) for r in sup],
            "shipments": ships}


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
