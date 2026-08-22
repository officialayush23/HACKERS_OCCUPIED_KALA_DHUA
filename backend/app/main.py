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
from .scenarios import (EVENT_TYPES, SCENARIOS, list_scenarios,
                        register_custom, unregister_custom)
from .solver import solve_for_production_order
from .scorer import score_run
from . import agent, comms, learning, llm
from .risk import assess as assess_risk

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


class CustomScenario(BaseModel):
    name: str
    events: list[dict[str, Any]]
    tests: str | None = None
    run: bool = True


@app.post("/api/scenarios/custom")
async def add_custom_scenario(body: CustomScenario):
    """Register a scenario written by whoever is testing this, and run it.

    It goes into the same registry the built-ins live in, so it executes down the
    identical code path — there is no separate "custom" mode that could behave
    differently from the one we demo. Custom scenarios are in-memory only and
    disappear on restart, so nothing anyone types here can become a permanent
    part of the suite by accident.
    """
    try:
        sid = register_custom(body.name, body.events, body.tests)
    except ValueError as e:
        raise HTTPException(400, str(e))

    detail = next((s for s in list_scenarios() if s["id"] == sid), None)
    if not body.run:
        return {"scenario_id": sid, "scenario": detail, "status": "registered"}
    try:
        out = await injector.inject(sid)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {**out, "scenario": detail}


@app.delete("/api/scenarios/custom/{scenario_id}")
async def remove_custom_scenario(scenario_id: str):
    try:
        unregister_custom(scenario_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "removed": scenario_id}


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

    # A demo reset re-seeds the world but deliberately keeps the audit log. Without
    # a marker in that log there is no way to tell which events describe the world
    # that exists now — which is how the activity feed ends up narrating a run that
    # was wiped, while every other panel correctly reports an empty world.
    async with pool.acquire() as conn:
        await emit(conn, actor="system", event_type="WORLD_RESET",
                   human_summary=f"World re-seeded ({mode}). Everything above this line "
                                 f"describes a previous run.",
                   payload={"mode": mode})
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
                after: int = 0, limit: int = 300, since_reset: bool = True):
    """The log for the world that exists now, unless you ask for everything.

    `since_reset=true` (the default) returns only events after the most recent
    WORLD_RESET. The full history is still there — pass `since_reset=false` to
    read it — but a dashboard showing a reset run's events beside a freshly
    seeded world is worse than showing nothing.
    """
    pool = await db()
    async with pool.acquire() as conn:
        if since_reset and run_id is None:
            mark = await conn.fetchval(
                "select max(sequence) from audit_events where event_type='WORLD_RESET'")
            if mark:
                after = max(after, int(mark))
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
        # supplier_effective, never suppliers + supplier_memory by hand. Trust has
        # exactly one definition and this is not the place to re-derive it.
        sup = await conn.fetch(
            """select s.*, se.effective_reliability, se.seeded_prior,
                      se.contradictions_detected, se.quality_failures, se.avg_delay_days,
                      se.deliveries_on_time, se.deliveries_late,
                      se.units_delivered, se.units_rejected, se.last_event
                 from suppliers s join supplier_effective se on se.supplier_id = s.id
                order by se.effective_reliability desc nulls last""")
    return {
        "clock": CLOCK.state(),
        "inventory": [dict(r) for r in inv],
        "purchase_orders": [dict(r) for r in pos],
        "production_orders": [dict(r) for r in prod],
        "suppliers": [dict(r) for r in sup],
    }


@app.get("/api/solve/{production_order_id}")
async def solve_endpoint(production_order_id: str, record: bool = False,
                         exclude: str = ""):
    """Run the deterministic solver. No LLM anywhere on this path.

    `record=true` writes the reasoning to the audit log.
    `exclude=SUP-21,SUP-64` drops those suppliers from the candidate pool before
    anything is scored — this is the what-if. A simulation never records.
    """
    drop = [x.strip().upper() for x in exclude.split(",") if x.strip()]
    pool = await db()
    async with pool.acquire() as conn:
        try:
            result = await solve_for_production_order(
                conn, production_order_id, exclude=drop)
        except ValueError as e:
            raise HTTPException(404, str(e))

        if record and not drop:
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


class RescheduleBody(BaseModel):
    production_order_id: str
    delay_days: int = 7
    reason: str = ""
    incident_id: str | None = None
    approved_by: str = "operator"


@app.post("/api/production/reschedule")
async def reschedule_production(body: RescheduleBody):
    """Stand a production run down so its allocated units can go elsewhere.

    This is the one lever that costs no money and still needs a human every
    time: the delay lands on another customer's order. The agent may propose
    it; only an operator commits it.
    """
    if body.delay_days < 1 or body.delay_days > 30:
        raise HTTPException(400, "delay_days must be between 1 and 30")

    pool = await db()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """select po.id, po.deadline, po.original_deadline, po.priority::text as priority,
                      po.allocated_units, po.oem_customer, po.required_component,
                      pr.name as product_name
                 from production_orders po
                 left join products pr on pr.id = po.product_id
                where po.id = $1""", body.production_order_id)
        if row is None:
            raise HTTPException(404, f"unknown production order {body.production_order_id}")
        if row["allocated_units"] <= 0:
            raise HTTPException(409, f"{row['id']} holds no units — nothing to release")

        updated = await conn.fetchrow(
            """update production_orders
                  set deadline           = deadline + make_interval(days => $2),
                      original_deadline  = coalesce(original_deadline, deadline),
                      rescheduled_at     = now(),
                      rescheduled_reason = nullif($3, ''),
                      allocated_units    = 0
                where id = $1
            returning deadline, original_deadline, allocated_units""",
            body.production_order_id, body.delay_days, body.reason)

        what = row["product_name"] or row["id"]
        freed = int(row["allocated_units"])
        await emit(conn, incident_id=body.incident_id, actor=body.approved_by,
                   event_type="PRODUCTION_RESCHEDULED",
                   human_summary=(
                       f"{what} for {row['oem_customer']} pushed back {body.delay_days} days. "
                       f"That releases {freed} units of {row['required_component']} "
                       f"to the line that is about to stop."),
                   payload={"production_order_id": row["id"],
                            "oem_customer": row["oem_customer"],
                            "priority": row["priority"],
                            "units_freed": freed,
                            "delay_days": body.delay_days,
                            "was_due": row["deadline"].isoformat(),
                            "now_due": updated["deadline"].isoformat(),
                            "original_deadline": updated["original_deadline"].isoformat(),
                            "reason": body.reason,
                            "approved_by": body.approved_by})

        # The shortage that triggered this has changed shape — let the agent look
        # again rather than leaving it holding a stale plan.
        await injector._react(conn, row["required_component"], "production_rescheduled")

    return {"ok": True, "production_order_id": row["id"], "units_freed": freed,
            "delay_days": body.delay_days,
            "now_due": updated["deadline"].isoformat()}


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
                      se.effective_reliability, se.seeded_prior,
                      se.contradictions_detected, se.deliveries_on_time,
                      se.deliveries_late, se.units_delivered, se.units_rejected,
                      array_agg(distinct l.mode::text) as modes,
                      min(l.transit_days) as transit_days,
                      array_agg(distinct sc.component_id) as components
                 from suppliers s
                 join supplier_effective se on se.supplier_id = s.id
                 left join supplier_lanes l on l.supplier_id = s.id
                 left join supplier_catalog sc on sc.supplier_id = s.id
                group by s.id, s.name, s.city, s.country, s.lat, s.lng,
                         se.effective_reliability, se.seeded_prior,
                         se.contradictions_detected, se.deliveries_on_time,
                         se.deliveries_late, se.units_delivered, se.units_rejected""")
        shipments = await conn.fetch(
            """select p.id, p.supplier_id, p.component_id, p.status::text as status,
                      p.mode::text as mode, p.quantity, p.total_value,
                      p.expected_delivery, t.supplier_claim, t.tracking_status
                 from purchase_orders p
                 left join shipment_tracking t on t.po_id = p.id
                where p.status in ('open','in_transit','delayed')""")
        # What the agent actually DID with each supplier. Hovering a node should
        # answer "and what did you do about it?", not just show a trust number.
        acts = await conn.fetch(
            """select technical_payload->>'supplier_id' as supplier_id,
                      event_type, human_summary, ts, sequence
                 from audit_events
                where technical_payload->>'supplier_id' is not null
                order by sequence desc limit 400""")
        learned = await conn.fetch(
            """select supplier_id, event, delta, after_score, reason, created_at
                 from reliability_events order by id desc limit 200""")

    now = CLOCK.now()
    ships = []
    for r in shipments:
        contradiction = (r["supplier_claim"] in ("dispatched", "in_transit")
                         and r["tracking_status"] in ("label_created_no_pickup", "not_shipped"))
        hrs = (r["expected_delivery"] - now).total_seconds() / 3600
        ships.append({**dict(r), "contradiction": contradiction,
                      "hours_to_eta": round(hrs, 1),
                      "progress": max(0.05, min(0.95, 1 - (hrs / 240)))})

    by_supplier: dict[str, list] = {}
    for a in acts:
        by_supplier.setdefault(a["supplier_id"], [])
        if len(by_supplier[a["supplier_id"]]) < 5:
            by_supplier[a["supplier_id"]].append(
                {"event": a["event_type"], "summary": a["human_summary"],
                 "ts": a["ts"].isoformat()})

    trust_moves: dict[str, list] = {}
    for l in learned:
        trust_moves.setdefault(l["supplier_id"], [])
        if len(trust_moves[l["supplier_id"]]) < 3:
            trust_moves[l["supplier_id"]].append(
                {"event": l["event"], "delta": float(l["delta"] or 0),
                 "after": float(l["after_score"] or 0), "reason": l["reason"]})

    return {"plant": dict(plant) if plant else None,
            "suppliers": [{**dict(r),
                           "actions": by_supplier.get(r["id"], []),
                           "trust_moves": trust_moves.get(r["id"], [])}
                          for r in sup],
            "shipments": ships}




# ============================ AGENT ==========================================


class ResumeBody(BaseModel):
    decision: str                       # approve | reject | modify
    note: str | None = None
    exclude: list[str] = []


class AskBody(BaseModel):
    question: str
    incident_id: str | None = None


@app.get("/api/agent/state")
async def agent_state(incident_id: str | None = None):
    if incident_id:
        return agent.state_of(incident_id) or {}
    return {"incidents": agent.all_states()}


@app.get("/api/agent/steps/{incident_id}")
async def agent_steps(incident_id: str):
    st = agent.state_of(incident_id) or {}
    pool = await db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """select sequence, ts, actor, event_type, human_summary, technical_payload,
                      simulated_at_seconds
                 from audit_events where incident_id=$1 order by sequence""", incident_id)
        inc = await conn.fetchrow(
            """select i.*, c.display_name as component_name, c.part_number
                 from incidents i left join components c on c.id=i.component_id
                where i.id=$1""", incident_id)
        plan = await conn.fetchrow(
            "select * from recovery_plans where incident_id=$1 order by id desc limit 1",
            incident_id)
    return {"incident": dict(inc) if inc else None,
            "state": st,
            "plan": dict(plan) if plan else None,
            "events": [dict(r) for r in rows]}


@app.post("/api/agent/resume/{incident_id}")
async def agent_resume(incident_id: str, body: ResumeBody):
    if body.decision not in ("approve", "reject", "modify"):
        raise HTTPException(400, "decision must be approve, reject or modify")
    pool = await db()
    async with pool.acquire() as conn:
        await conn.execute(
            """update approvals set status=$2::approval_status, decided_by='operator',
                   decided_at=now()
                where incident_id=$1 and status='pending'""",
            incident_id,
            "approved" if body.decision == "approve" else "rejected")
        await agent.resume(conn, incident_id, decision=body.decision,
                           note=body.note, exclude=body.exclude)
    return {"ok": True, "decision": body.decision}


@app.post("/api/agent/verify/{incident_id}")
async def agent_verify(incident_id: str):
    pool = await db()
    async with pool.acquire() as conn:
        return await agent.verify(conn, incident_id)


@app.post("/api/agent/ask")
async def agent_ask(body: AskBody):
    """Conversational agent. Reads deterministic state; never mutates it."""
    pool = await db()
    async with pool.acquire() as conn:
        inc = await conn.fetch(
            """select i.id, i.title, i.severity::text, i.status::text, i.narrative,
                      c.display_name as component
                 from incidents i left join components c on c.id=i.component_id
                where i.status not in ('resolved','failed') limit 5""")
        plans = await conn.fetch(
            """select incident_id, label, total_cost, status, rationale
                 from recovery_plans order by id desc limit 5""")
        rejects = await conn.fetch(
            """select human_summary, technical_payload from audit_events
                where event_type='OPTION_REJECTED' order by sequence desc limit 8""")
        inv = await conn.fetch(
            """select c.display_name, i.usable_stock, i.erp_stock, i.daily_usage
                 from inventory i join components c on c.id=i.component_id""")
    state = {"open_incidents": [dict(r) for r in inc],
             "recent_plans": [dict(r) for r in plans],
             "recent_rejections": [r["human_summary"] for r in rejects],
             "inventory": [dict(r) for r in inv]}
    answer, used_llm = await llm.answer_question(body.question, state)
    # Say what the answer was formed from. An answer with no visible grounding is
    # indistinguishable from an answer that was made up.
    grounding = [f"{len(state['open_incidents'])} open incidents",
                 f"{len(state['recent_plans'])} recovery plans",
                 f"{len(state['recent_rejections'])} recorded refusals",
                 f"{len(state['inventory'])} components in stock"]
    return {"answer": answer, "llm": used_llm, "grounding": grounding}


@app.get("/api/llm/health")
async def llm_health():
    return await llm.health()


# ============================ COMMS ==========================================


@app.get("/api/threads")
async def threads(incident_id: str | None = None):
    pool = await db()
    async with pool.acquire() as conn:
        return {"threads": await comms.threads_for(conn, incident_id)}


class HumanMessage(BaseModel):
    thread_id: int
    body: str
    incident_id: str | None = None


@app.post("/api/threads/message")
async def human_message(m: HumanMessage):
    pool = await db()
    async with pool.acquire() as conn:
        return await comms.post(conn, thread_id=m.thread_id, direction="outbound",
                                author_type="human", author_name="Operator",
                                body=m.body, incident_id=m.incident_id)


# ========================== WAREHOUSE ========================================


class TaskResult(BaseModel):
    usable_stock: int
    quarantined_stock: int = 0
    reason: str | None = None


@app.get("/api/warehouse")
async def warehouse():
    pool = await db()
    async with pool.acquire() as conn:
        tasks = await conn.fetch(
            """select w.*, c.display_name as component_name, c.part_number
                 from warehouse_tasks w left join components c on c.id=w.component_id
                order by case w.status when 'open' then 0 when 'in_progress' then 1 else 2 end,
                         case w.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
                         w.id desc limit 40""")
        inv = await conn.fetch(
            """select i.*, c.display_name, c.part_number, c.is_hazmat,
                      round(i.usable_stock::numeric / nullif(i.daily_usage,0),1) as coverage_days
                 from inventory i join components c on c.id=i.component_id
                order by coverage_days nulls last""")
        inbound = await conn.fetch(
            """select p.*, c.display_name as component_name,
                      coalesce(s.legal_name, s.name) as supplier_name,
                      t.tracking_status, t.supplier_claim
                 from purchase_orders p
                 join components c on c.id=p.component_id
                 join suppliers s on s.id=p.supplier_id
                 left join shipment_tracking t on t.po_id=p.id
                where p.status in ('open','in_transit','delayed')
                order by p.expected_delivery""")
        receipts = await conn.fetch(
            """select g.*, c.display_name as component_name from goods_receipts g
                 join components c on c.id=g.component_id order by g.id desc limit 20""")
    return {"tasks": [dict(r) for r in tasks], "inventory": [dict(r) for r in inv],
            "inbound": [dict(r) for r in inbound], "receipts": [dict(r) for r in receipts]}


@app.post("/api/warehouse/tasks/{task_id}/complete")
async def complete_task(task_id: int, result: TaskResult):
    pool = await db()
    async with pool.acquire() as conn:
        try:
            out = await comms.warehouse_complete_task(conn, task_id, result.model_dump())
        except ValueError as e:
            raise HTTPException(404, str(e))
        # Physical reality changed → the agent re-evaluates. Loop closed.
        await agent.wake(conn, component_id=out["component_id"],
                         trigger="warehouse physical count")
    return out


class ReceiptBody(BaseModel):
    po_id: str
    quantity_received: int
    quantity_approved: int
    reason: str | None = None


@app.post("/api/warehouse/receive")
async def receive_shipment(b: ReceiptBody):
    """Received is not usable. This is the quality gate."""
    pool = await db()
    async with pool.acquire() as conn:
        po = await conn.fetchrow("select * from purchase_orders where id=$1", b.po_id)
        if not po:
            raise HTTPException(404, "unknown purchase order")
        quarantined = b.quantity_received - b.quantity_approved
        await conn.execute(
            """insert into goods_receipts (po_id, component_id, facility_id,
                   quantity_received, quantity_approved, quantity_quarantined, inspection_status,
                   inspected_at)
               values ($1,$2,'Pune-Plant-1',$3,$4,$5,$6,now())""",
            b.po_id, po["component_id"], b.quantity_received, b.quantity_approved,
            quarantined, "passed" if quarantined == 0 else
            ("failed" if b.quantity_approved == 0 else "partial"))
        await conn.execute(
            """update inventory set usable_stock = usable_stock + $2,
                   erp_stock = erp_stock + $3,
                   quarantined_stock = quarantined_stock + $4, last_updated = now()
                where component_id=$1""",
            po["component_id"], b.quantity_approved, b.quantity_received, quarantined)
        await conn.execute("update purchase_orders set status='delivered' where id=$1", b.po_id)

        name = await conn.fetchval(
            "select coalesce(display_name,id) from components where id=$1", po["component_id"])
        await emit(conn, actor="warehouse", event_type="GOODS_RECEIVED",
                   human_summary=f"Received {b.quantity_received} {name} against {b.po_id}. "
                                 f"{b.quantity_approved} passed inspection"
                                 + (f", {quarantined} quarantined." if quarantined else "."),
                   payload={"po_id": b.po_id, "received": b.quantity_received,
                            "approved": b.quantity_approved, "quarantined": quarantined})

        inc = await conn.fetchval(
            """select id from incidents where component_id=$1
                and status not in ('resolved','failed') order by opened_at desc limit 1""",
            po["component_id"])

        # The delivery landed. This is the only moment a supplier can *earn*
        # trust back, so it has to run whether or not an incident is open.
        learned = await learning.on_goods_received(
            conn, po_id=b.po_id, quantity_received=b.quantity_received,
            quantity_rejected=quarantined, incident_id=inc)

        if inc:
            out = await agent.verify(conn, inc)
            return {**(out if isinstance(out, dict) else {"ok": True}), "learned": learned}
    return {"ok": True, "learned": learned}


# =========================== APPROVALS =======================================


@app.get("/api/approvals")
async def approvals():
    pool = await db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """select a.*, i.title, i.severity::text as severity,
                      c.display_name as component_name,
                      (select payload from recovery_plans rp
                        where rp.incident_id=a.incident_id order by rp.id desc limit 1) as plan
                 from approvals a
                 left join incidents i on i.id=a.incident_id
                 left join components c on c.id=i.component_id
                order by case a.status when 'pending' then 0 else 1 end, a.id desc limit 30""")
    return {"approvals": [dict(r) for r in rows]}


class ApproveBody(BaseModel):
    decision: str = "approve"           # approve | reject
    note: str | None = None
    decided_by: str = "operator"


@app.post("/api/approvals/{approval_id}/decide")
async def decide_approval(approval_id: int, body: ApproveBody):
    """Actually decide an approval, and resume the agent.

    The Decision Explorer previously had an Approve button that only navigated to
    the approvals screen. Pressing it looked like approving and changed nothing —
    which is the worst possible behaviour for the one control that exists to stop
    the agent spending money.
    """
    if body.decision not in ("approve", "reject"):
        raise HTTPException(400, "decision must be 'approve' or 'reject'")

    pool = await db()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select * from approvals where id=$1", approval_id)
        if row is None:
            raise HTTPException(404, f"unknown approval {approval_id}")
        if row["status"] != "pending":
            raise HTTPException(409, f"approval {approval_id} is already {row['status']}")

        await conn.execute(
            "update approvals set status=$2, decided_at=now() where id=$1",
            approval_id, "approved" if body.decision == "approve" else "rejected")

        await emit(conn, incident_id=row["incident_id"], actor=body.decided_by,
                   event_type="APPROVAL_DECIDED",
                   human_summary=(f"{body.decided_by} {body.decision}d: {row['action']}"
                                  + (f" \u2014 {body.note}" if body.note else "")),
                   payload={"approval_id": approval_id, "decision": body.decision,
                            "action": row["action"],
                            "estimated_cost": float(row["estimated_cost"] or 0),
                            "note": body.note, "decided_by": body.decided_by})

        if row["incident_id"]:
            await agent.resume(conn, row["incident_id"],
                               decision=body.decision, note=body.note)

    return {"ok": True, "approval_id": approval_id, "decision": body.decision,
            "incident_id": row["incident_id"]}


# ========================= BUSINESS CONTEXT ==================================


@app.get("/api/suppliers/{supplier_id}/reliability")
async def supplier_reliability(supplier_id: str):
    """Trust, and the record that produced it.

    The number on its own is an opinion. With the events behind it, it is an
    argument the operator can check — and disagree with.
    """
    pool = await db()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select * from supplier_effective where supplier_id=$1", supplier_id)
        if row is None:
            raise HTTPException(404, f"unknown supplier {supplier_id}")
        return {"supplier": dict(row),
                "history": await learning.history(conn, supplier_id)}


@app.get("/api/accuracy")
async def accuracy():
    """How often is the agent actually right?

    Every number here is checkable against the audit log, and each one is a
    *verified* outcome rather than a self-report:

      constraint_compliance — recovery orders raised, versus how many of them
        violated a hard rule. Any violation is a failure, however cheap.
      claim_verification    — supplier claims that contradicted carrier tracking,
        and how many the agent caught rather than believed.
      delivery_accuracy     — did the stock the agent bought actually turn up
        usable, in the quantity it planned for.
      escalation_precision  — of the things it stopped and asked about, how many
        genuinely crossed its authority. Stopping unnecessarily wastes a human;
        not stopping is worse.
      interpretation        — supplier replies read into structured facts, versus
        replies it correctly refused to guess at.
    """
    pool = await db()
    async with pool.acquire() as conn:
        pos = await conn.fetch(
            """select p.id, p.quantity, p.unit_price, p.component_id, p.supplier_id,
                      p.mode::text as mode, p.status::text as status,
                      c.required_certifications, c.is_hazmat,
                      se.certifications, sc.min_order_quantity
                 from purchase_orders p
                 join components c on c.id = p.component_id
                 left join supplier_effective se on se.supplier_id = p.supplier_id
                 left join supplier_catalog sc on sc.supplier_id = p.supplier_id
                                              and sc.component_id = p.component_id
                where p.created_by_agent""")

        violations = []
        for p in pos:
            need = set(p["required_certifications"] or [])
            have = set(p["certifications"] or [])
            if need - have:
                violations.append({"po_id": p["id"], "rule": "REQUIRED_CERTIFICATION",
                                   "detail": f"missing {', '.join(sorted(need - have))}"})
            if p["min_order_quantity"] and p["quantity"] < p["min_order_quantity"]:
                violations.append({"po_id": p["id"], "rule": "MIN_ORDER_QUANTITY",
                                   "detail": f"ordered {p['quantity']}, "
                                             f"minimum {p['min_order_quantity']}"})
            if p["is_hazmat"] and (p["mode"] or "").upper() == "AIR":
                violations.append({"po_id": p["id"], "rule": "HAZMAT_NO_AIR",
                                   "detail": "hazmat routed by air"})

        contradictions_real = await conn.fetchval(
            """select count(*) from shipment_tracking t
                where t.supplier_claim in ('dispatched','in_transit')
                  and t.tracking_status in ('label_created_no_pickup','not_shipped')""") or 0
        contradictions_caught = await conn.fetchval(
            "select count(*) from audit_events where event_type='CLAIM_CONTRADICTED'") or 0

        receipts = await conn.fetch(
            """select g.quantity_received, g.quantity_approved, p.quantity as ordered
                 from goods_receipts g
                 join purchase_orders p on p.id = g.po_id
                where p.created_by_agent""")

        escalations = await conn.fetch(
            """select a.estimated_cost, a.reason from approvals a""")
        threshold = APPROVAL_THRESHOLD_INR
        justified = sum(1 for a in escalations
                        if float(a["estimated_cost"] or 0) > threshold
                        or "elay" in (a["reason"] or ""))

        interpreted = await conn.fetch(
            """select technical_payload from audit_events
                where event_type='MESSAGE_INTERPRETED'""")
        parsed = refused = 0
        for r in interpreted:
            pl = r["technical_payload"]
            pl = json.loads(pl) if isinstance(pl, str) else (pl or {})
            if pl.get("needs_human"):
                refused += 1
            elif pl.get("quantity_mentioned") is not None or pl.get("claim") not in (None, "unclear"):
                parsed += 1

    def pct(n, d):
        return None if not d else round(100.0 * n / d, 1)

    delivered = sum(r["quantity_approved"] or 0 for r in receipts)
    planned = sum(r["ordered"] or 0 for r in receipts)

    return {
        "constraint_compliance": {
            "orders_raised": len(pos),
            "violations": len(violations),
            "detail": violations,
            "score_pct": pct(len(pos) - len(violations), len(pos)),
            "note": "A single violation is a failure. Cost never excuses one.",
        },
        "claim_verification": {
            "contradictions_present": int(contradictions_real),
            "caught": int(contradictions_caught),
            "score_pct": pct(contradictions_caught, contradictions_real),
            "note": "Supplier claims the carrier data disproves, and how many were caught.",
        },
        "delivery_accuracy": {
            "units_planned": int(planned),
            "units_usable_on_arrival": int(delivered),
            "score_pct": pct(delivered, planned),
            "note": "Ordering is not recovering. This counts what became usable stock.",
        },
        "escalation_precision": {
            "escalations": len(escalations),
            "genuinely_over_authority": int(justified),
            "score_pct": pct(justified, len(escalations)),
            "note": f"Over Rs {threshold:,} or delaying another customer. "
                    f"Stopping needlessly wastes a human; not stopping is worse.",
        },
        "interpretation": {
            "messages_read": parsed + refused,
            "parsed_into_facts": parsed,
            "refused_to_guess": refused,
            "note": "Refusing to guess is a correct outcome, not a failure.",
        },
    }


@app.get("/api/now")
async def now_state():
    """One answer to "what is happening right now?"

    Deliberately small and deliberately ranked: an operator glancing at a strip
    at the top of the screen has room for a handful of facts, and the ones that
    matter are the ones that need them.
    """
    pool = await db()
    async with pool.acquire() as conn:
        actions = await conn.fetch(
            """select a.id, a.incident_id, a.action, a.estimated_cost, a.reason,
                      i.component_id, c.display_name as component_name
                 from approvals a
                 left join incidents i on i.id = a.incident_id
                 left join components c on c.id = i.component_id
                where a.status = 'pending' order by a.id desc""")
        tasks = await conn.fetch(
            """select w.id, w.task_type, w.priority, w.instructions,
                      c.display_name as component_name
                 from warehouse_tasks w
                 left join components c on c.id = w.component_id
                where w.status in ('open','in_progress')
                order by case w.priority when 'urgent' then 0 when 'high' then 1
                                         when 'normal' then 2 else 3 end, w.id""")
        waiting = await conn.fetch(
            """select t.id, t.counterparty_name, t.counterparty_type, t.subject
                 from message_threads t
                where t.status = 'awaiting_reply' order by t.id desc limit 6""")
        incidents = await conn.fetch(
            """select i.id, i.status::text as status, i.severity::text as severity,
                      i.title, i.component_id, c.display_name as component_name
                 from incidents i
                 left join components c on c.id = i.component_id
                where i.status not in ('resolved','failed')
                order by case i.severity::text when 'critical' then 0 when 'high' then 1
                                               when 'medium' then 2 else 3 end,
                         i.opened_at desc""")
        next_delivery = await conn.fetchrow(
            """select p.id, p.expected_delivery, p.quantity, s.name as supplier_name,
                      c.display_name as component_name
                 from purchase_orders p
                 left join suppliers s on s.id = p.supplier_id
                 left join components c on c.id = p.component_id
                where p.status in ('open','in_transit')
                order by p.expected_delivery limit 1""")
        # ONE definition of "is production at risk", used by every panel. Three
        # panels each computing their own is how the dashboard came to say
        # "all clear" and "short by 310" at the same time.
        at_risk = await conn.fetch(
            """select po.id, po.priority::text as priority, po.oem_customer, po.deadline,
                      pr.name as product_name,
                      c.id as component_id, c.display_name as component_name,
                      po.units_planned * po.component_per_unit as required_units,
                      i.usable_stock - coalesce(other.claimed,0) as available,
                      i.erp_stock, i.safety_stock, i.daily_usage,
                      po.units_planned * po.component_per_unit
                        - (i.usable_stock - coalesce(other.claimed,0)) + i.safety_stock
                        as shortfall,
                      case when i.daily_usage > 0
                           then round((i.usable_stock - coalesce(other.claimed,0))::numeric
                                      / i.daily_usage, 1) end as coverage_days
                 from production_orders po
                 join inventory i on i.component_id = po.required_component
                                 and i.warehouse_id = po.warehouse_id
                 join components c on c.id = po.required_component
                 left join products pr on pr.id = po.product_id
                 left join lateral (
                       select sum(o.allocated_units) as claimed
                         from production_orders o
                        where o.required_component = po.required_component
                          and o.warehouse_id = po.warehouse_id
                          and o.id <> po.id and not o.is_on_hold
                 ) other on true
                where not po.is_on_hold
                  and po.units_planned * po.component_per_unit
                      - (i.usable_stock - coalesce(other.claimed,0)) + i.safety_stock > 0
                order by shortfall desc""")
        cover = await conn.fetchval(
            """select min(case when daily_usage > 0
                               then usable_stock::numeric / daily_usage else 999 end)
                 from inventory""")
        working = await conn.fetchval(
            """select count(*) from incidents
                where status not in ('resolved','failed')""")

    def _cover(v):
        return round(float(v), 1) if v is not None else None

    # The action queue, in the order a human should work it.
    queue = []
    for a in actions:
        queue.append({"kind": "approval", "urgency": "critical", "id": f"approval-{a['id']}",
                      "incident_id": a["incident_id"],
                      "title": a["action"],
                      "detail": a["reason"],
                      "cost": float(a["estimated_cost"] or 0),
                      "cta": "Review"})
    for t in tasks:
        queue.append({"kind": "warehouse", "id": f"task-{t['id']}",
                      "urgency": "high" if t["priority"] in ("urgent", "high") else "normal",
                      "title": f"{t['task_type'].replace('_', ' ').capitalize()}"
                               + (f" — {t['component_name']}" if t["component_name"] else ""),
                      "detail": t["instructions"], "cta": "Open"})
    for w in waiting:
        queue.append({"kind": "waiting", "urgency": "normal", "id": f"thread-{w['id']}",
                      "title": f"Waiting on {w['counterparty_name']}",
                      "detail": w["subject"], "cta": "View"})

    risk = [dict(r) for r in at_risk]
    # The tightest cover that actually belongs to something at risk. A global
    # minimum across every component answers a question nobody asked.
    at_risk_cover = min((r["coverage_days"] for r in risk
                         if r["coverage_days"] is not None), default=None)

    return {
        "clock": CLOCK.state(),
        "queue": queue,
        "incidents": [dict(r) for r in incidents],
        "at_risk": risk,
        "production_at_risk": len(risk) > 0,
        "worst": risk[0] if risk else None,
        "min_coverage_days": _cover(at_risk_cover if risk else cover),
        "agent_busy": int(working or 0),
        "next_delivery": (
            {"po_id": next_delivery["id"],
             "supplier_name": next_delivery["supplier_name"],
             "component_name": next_delivery["component_name"],
             "quantity": next_delivery["quantity"],
             "hours_away": round(
                 (next_delivery["expected_delivery"] - CLOCK.now()).total_seconds() / 3600, 1)}
            if next_delivery else None),
    }


@app.get("/api/context")
async def business_context():
    """Who we are, what we build, what is at risk. Names, not IDs."""
    pool = await db()
    async with pool.acquire() as conn:
        org = await conn.fetchrow("select * from organizations limit 1")
        prods = await conn.fetch(
            """select p.*, count(b.component_id) as component_count
                 from products p left join bill_of_materials b on b.product_id=p.id
                group by p.id order by p.id""")
        orders = await conn.fetch(
            """select po.id, po.priority::text as priority, po.deadline, po.oem_customer,
                      po.units_planned, pr.name as product_name,
                      c.display_name as component_name, c.part_number,
                      i.usable_stock, i.erp_stock, i.daily_usage,
                      po.units_planned*po.component_per_unit - i.usable_stock + i.safety_stock
                        as shortfall
                 from production_orders po
                 left join products pr on pr.id=po.product_id
                 join components c on c.id=po.required_component
                 join inventory i on i.component_id=po.required_component
                order by po.deadline""")
    return {"organization": dict(org) if org else None,
            "products": [dict(r) for r in prods],
            "production": [dict(r) for r in orders]}


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
