"""FastAPI app — REST + WebSocket.

Only this service writes to Postgres. The dashboard reads through here and
subscribes to /ws for the live event stream.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import pathlib
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .core import (APPROVAL_THRESHOLD_INR, CLOCK, HUB, close_db, db, emit,
                    set_run_context)
from . import injector
from .scenarios import (EVENT_SCHEMA, EVENT_TYPES, REF_TABLES, SCENARIOS,
                        list_scenarios, referenced_ids, register_custom,
                        unregister_custom, validate_custom)
from .solver import solve_for_production_order
from .scorer import score_run
from . import (agent, command, comms, evaluation, intelligence, learning, llm,
               supplier_portal, worldbuild)
from .risk import assess as assess_risk

SEED_PATH = pathlib.Path(__file__).resolve().parents[2] / "supabase" / "seed.sql"

app = FastAPI(title="Supply Chain Disruption Control Agent", version="0.1.0")
# Deployed, the frontend is no longer on localhost, and a CORS rule that only
# knows about localhost turns every preflight into a 400 that reads like a
# routing bug. ALLOWED_ORIGINS is a comma-separated list for the deployed
# frontends; localhost stays matched by regex so nobody has to configure
# anything to run this on their own machine.
_EXTRA_ORIGINS = [o.strip().rstrip("/")
                  for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_EXTRA_ORIGINS,
    # Any localhost port: 5173 is `vite dev`, 4173 is `vite preview`, and
    # teammates run on whatever port is free.
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)


@app.get("/")
async def root():
    """Something truthful at the root.

    Render, uptime checks and anyone who pastes the base URL into a browser all
    hit `/`. A 404 there says "this is broken" about a service that is fine.
    """
    return {"service": "DisruptionOps API", "status": "ok",
            "docs": "/docs", "health": "/api/health", "websocket": "/ws"}


@app.get("/health")
async def plain_health():
    return {"status": "healthy"}


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
            "event_types": EVENT_TYPES, "event_schema": EVENT_SCHEMA}


# NB: this route and /validate must be declared BEFORE /api/scenarios/{scenario_id}.
# FastAPI matches in registration order, and a path parameter will happily
# swallow the literal "context" if it gets there first.
@app.get("/api/scenarios/context")
async def scenario_context():
    """The world as it stands, in the words a person uses for it.

    The scenario builder is generated from this. Nobody should ever have to type
    an ID: they pick "PO-7712 — Motor Driver IC — 1000 units from Zhen Hua
    Electronics" and the ID travels underneath.

    Every list carries the foreign keys the UI needs to make one dropdown narrow
    another — choose a component and only that component's shipments remain.
    """
    pool = await db()
    async with pool.acquire() as conn:
        comps = await conn.fetch(
            """select c.id, coalesce(c.display_name, c.name) as name, c.part_number,
                      c.category, c.is_hazmat, c.required_certifications, c.origin,
                      i.usable_stock, i.erp_stock, i.daily_usage, i.safety_stock,
                      round(i.usable_stock::numeric / nullif(i.daily_usage,0),1)
                        as coverage_days
                 from components c
                 left join inventory i on i.component_id = c.id
                order by coverage_days nulls last, c.id""")
        sups = await conn.fetch(
            """select s.id, coalesce(s.legal_name, s.name) as name, s.city, s.country,
                      s.certifications, s.quality_score, s.origin,
                      se.effective_reliability,
                      array_agg(distinct sc.component_id)
                        filter (where sc.component_id is not null) as components,
                      array_agg(distinct l.mode::text)
                        filter (where l.mode is not null) as modes
                 from suppliers s
                 join supplier_effective se on se.supplier_id = s.id
                 left join supplier_catalog sc on sc.supplier_id = s.id
                 left join supplier_lanes l on l.supplier_id = s.id
                group by s.id, s.legal_name, s.name, s.city, s.country, s.certifications,
                         s.quality_score, s.origin, se.effective_reliability
                order by s.id""")
        pos = await conn.fetch(
            """select p.id, p.component_id, p.supplier_id, p.quantity,
                      p.status::text as status, p.mode::text as mode,
                      p.expected_delivery, p.created_by_agent,
                      coalesce(c.display_name, c.name) as component_name,
                      coalesce(s.legal_name, s.name) as supplier_name,
                      t.supplier_claim, t.tracking_status
                 from purchase_orders p
                 join components c on c.id = p.component_id
                 join suppliers s on s.id = p.supplier_id
                 left join shipment_tracking t on t.po_id = p.id
                where p.status <> 'cancelled'
                order by p.expected_delivery""")
        prods = await conn.fetch(
            """select po.id, po.required_component as component_id, po.units_planned,
                      po.component_per_unit, po.priority::text as priority, po.deadline,
                      po.oem_customer, po.allocated_units, po.is_on_hold,
                      pr.name as product_name,
                      coalesce(c.display_name, c.name) as component_name
                 from production_orders po
                 left join products pr on pr.id = po.product_id
                 join components c on c.id = po.required_component
                order by po.deadline""")
        whs = await conn.fetch("select id, name, city from warehouses order by id")

    def po_label(p):
        return (f"{p['id']} — {p['component_name']} — {p['quantity']} units "
                f"from {p['supplier_name']}")

    return {
        "clock": CLOCK.state(),
        "components": [
            {**dict(c), "label": f"{c['name']} ({c['id']})"} for c in comps],
        "suppliers": [
            {**dict(s), "label": f"{s['name']} ({s['id']})",
             "staffed": supplier_portal.present(s["id"])} for s in sups],
        "purchase_orders": [{**dict(p), "label": po_label(p)} for p in pos],
        "production_orders": [
            {**dict(p),
             "label": (f"{p['product_name'] or p['id']} for {p['oem_customer']} — "
                       f"{p['units_planned']} units, {p['priority']} priority")}
            for p in prods],
        "warehouses": [{**dict(w), "label": f"{w['name']} ({w['id']})"} for w in whs],
        "approval_threshold": APPROVAL_THRESHOLD_INR,
    }


class ValidateBody(BaseModel):
    name: str = "Untitled"
    events: list[dict[str, Any]] = []


@app.post("/api/scenarios/validate")
async def validate_scenario(body: ValidateBody):
    """Say whether a scenario would run, and if not, exactly why.

    Two passes. The first checks the shape against `EVENT_SCHEMA` — required
    fields, ranges, enum values. The second checks that every ID it names is a
    row that actually exists, because `PO-9999` should fail here rather than
    forty seconds into a run in front of an audience.
    """
    try:
        clean = validate_custom(body.name, body.events)
    except ValueError as e:
        return {"ok": False, "errors": [str(e)], "events": []}

    errors: list[str] = []
    pool = await db()
    async with pool.acquire() as conn:
        for where, field, ref_type, value in referenced_ids(clean):
            table, human = REF_TABLES[ref_type]
            exists = await conn.fetchval(
                f"select 1 from {table} where id = $1", value)   # table name is
            if not exists:                                       # from a fixed dict
                near = await conn.fetch(
                    f"select id from {table} order by id limit 6")
                errors.append(
                    f"{where}: no {human} called '{value}'. "
                    f"Try one of: {', '.join(r['id'] for r in near)}")

    return {"ok": not errors, "errors": errors, "events": clean,
            "span_sim_hours": max((e["at_h"] for e in clean), default=0)}


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
    # Optional world construction: suppliers, components, inventory, orders.
    world: dict[str, Any] | None = None


@app.post("/api/scenarios/custom")
async def add_custom_scenario(body: CustomScenario):
    """Register a scenario written by whoever is testing this, and run it.

    It goes into the same registry the built-ins live in, so it executes down the
    identical code path — there is no separate "custom" mode that could behave
    differently from the one we demo. Custom scenarios are in-memory only and
    disappear on restart, so nothing anyone types here can become a permanent
    part of the suite by accident.
    """
    # A `world` block is applied before the first event fires, so a tester can
    # construct the situation they want to test rather than only poke the seed.
    if body.world:
        pool = await db()
        try:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    built = await worldbuild.apply(conn, body.world)
        except worldbuild.WorldError as e:
            raise HTTPException(400, str(e))
    else:
        built = {}

    try:
        sid = register_custom(body.name, body.events, body.tests)
    except ValueError as e:
        raise HTTPException(400, str(e))

    detail = next((s for s in list_scenarios() if s["id"] == sid), None)
    if not body.run:
        return {"scenario_id": sid, "scenario": detail, "status": "registered",
                "world_applied": built}
    try:
        out = await injector.inject(sid)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {**out, "scenario": detail, "world_applied": built}


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
        # The world this run happened in has just been re-seeded, so the run is
        # no longer a description of anything. Leaving the pointer set is what
        # made "Reset world" produce a dashboard with a live incident and no
        # events behind it.
        await _set_active_run(conn, None)
        await conn.execute(sql)

        # Tables that hold no foreign key into the seeded world, and therefore
        # were quietly surviving a reset. A "clean" world showing four supplier
        # conversations and two unanswered questions from the previous run is
        # worse than not resetting at all, because you only find out when the
        # agent replies to a thread that no longer means anything.
        await conn.execute(
            "truncate message_threads, thread_messages restart identity cascade")
        await conn.execute("truncate recovery_plans restart identity cascade")
        await conn.execute("truncate agent_constraints restart identity cascade")
        await conn.execute("truncate human_input_requests restart identity cascade")
        await conn.execute("truncate warehouse_tasks restart identity cascade")

        if mode == "hard":
            await conn.execute(
                "truncate run_scores, scenario_runs, audit_events restart identity cascade")

    # In-process state has to go with it, or the agent keeps a checkpoint for an
    # incident that no longer exists and refuses to reopen the same component.
    agent._STATE.clear()
    for task in list(agent._RUNNING.values()):
        task.cancel()
    agent._RUNNING.clear()
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
    """Incidents belonging to the run the dashboard is scoped to.

    Unscoped, this endpoint is how the header could read "No test run" while the
    page underneath it rendered INC-1002 in full: `/api/now` obeyed the run
    contract and this did not. An incident is evidence about a run; with no run
    there is no evidence.
    """
    pool = await db()
    async with pool.acquire() as conn:
        run_id = await _active_run_id(conn)
        if run_id is None:
            return {"incidents": [], "scope": "no active run"}
        rows = await conn.fetch(
            """select i.*, c.name as component_name
                 from incidents i left join components c on c.id = i.component_id
                where i.scenario_run_id = $1
                order by i.opened_at desc limit 100""", run_id)
    return {"incidents": [dict(r) for r in rows], "scope": run_id}


async def _reset_floor(conn) -> int:
    """Sequence of the most recent WORLD_RESET, or 0 if the world was never reset.

    Every endpoint that aggregates over `audit_events` for a "what's true right
    now" panel (KPIs, network activity, accuracy, the assistant's grounding)
    must exclude anything at or before this mark — otherwise a reset world
    keeps narrating a run that no longer exists. `/api/audit` was the only
    place this was applied; the others quietly re-introduced the exact bug the
    WORLD_RESET marker was invented to fix.
    """
    mark = await conn.fetchval(
        "select max(sequence) from audit_events where event_type='WORLD_RESET'")
    return int(mark) if mark else 0


async def _active_run_id(conn) -> int | None:
    """The run the dashboard is scoped to, or None.

    None means *no run*, and every screen must then show an empty state rather
    than zeros. A 0% score with no run is a lie about a thing that never
    happened; `null` is not `0`.
    """
    run_id = await conn.fetchval("select scenario_run_id from active_run where id")
    if run_id is None:
        return None
    # Self-healing. A run that was reset away, or deleted, is not an active run,
    # and a pointer at one is how a wiped world came to render a live incident.
    # The check is one indexed lookup; correctness here is worth it on every poll.
    status = await conn.fetchval("select status from scenario_runs where id=$1", run_id)
    if status is None or status == 'reset':
        await conn.execute(
            "update active_run set scenario_run_id=null, updated_at=now() where id")
        return None
    return run_id


async def _set_active_run(conn, run_id: int | None) -> None:
    await conn.execute(
        "update active_run set scenario_run_id=$1, updated_at=now() where id", run_id)


@app.get("/api/runs/active")
async def active_run():
    """What the UI is looking at. The answer is allowed to be nothing."""
    pool = await db()
    async with pool.acquire() as conn:
        run_id = await _active_run_id(conn)
        if run_id is None:
            return {"active": None,
                    "note": "No test run. Baseline topology only — nothing has happened yet."}
        run = await conn.fetchrow(
            """select r.*, (select count(*) from audit_events e
                             where e.scenario_run_id = r.id) as event_count,
                      (select count(*) from incidents i
                        where i.scenario_run_id = r.id) as incident_count,
                      (select count(*) from recovery_plans p
                        where p.scenario_run_id = r.id) as decision_count,
                      (select count(*) from evaluation_results v
                        where v.scenario_run_id = r.id) as evaluated
                 from scenario_runs r where r.id=$1""", run_id)
        if run is None:
            await _set_active_run(conn, None)
            return {"active": None, "note": "The active run no longer exists."}
        d = dict(run)
        d["title"] = SCENARIOS.get(d.get("scenario_id"), {}).get("title", d.get("scenario_id"))
        d["tests"] = SCENARIOS.get(d.get("scenario_id"), {}).get("tests")
        return {"active": d}


@app.get("/api/evaluation/current")
async def current_evaluation():
    """The active run, judged against explicit criteria. May be nothing."""
    pool = await db()
    async with pool.acquire() as conn:
        run_id = await _active_run_id(conn)
        if run_id is None:
            return {"evaluated": False, "run_id": None,
                    "reason": "No active run. Nothing has been asked of the agent yet."}
        return await evaluation.evaluate(conn, run_id)


@app.post("/api/evaluation/{run_id}")
async def evaluate_run(run_id: int):
    """Re-judge a specific run from its own artefacts."""
    pool = await db()
    async with pool.acquire() as conn:
        return await evaluation.evaluate(conn, run_id)


@app.get("/api/world/explain")
async def explain_world():
    """What a test will run against — including which options are traps.

    A tester who cannot see which suppliers are cheap-and-refusable cannot tell
    whether the agent avoided them deliberately or by luck.
    """
    pool = await db()
    async with pool.acquire() as conn:
        return await worldbuild.explain(conn)


@app.post("/api/system/hard-reset")
async def hard_reset():
    """Delete every runtime artefact. Keep the static baseline.

    After this returns, there is no run, no incident, no decision, no log, no
    score. The suppliers, components, plants and policies survive — those are
    the world, not evidence about it.

    The frontend must also clear its cache; a clean backend behind a stale React
    cache still shows ghosts.
    """
    await injector.stop_all()
    if not SEED_PATH.exists():
        raise HTTPException(500, f"seed file not found at {SEED_PATH}")
    sql = SEED_PATH.read_text(encoding="utf-8")

    pool = await db()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Runtime artefacts, in dependency order. `restart identity` so the
            # next run is run 1 — a fresh world should not start at run 7.
            await conn.execute("""
                truncate evaluation_results, reliability_events, goods_receipts,
                         warehouse_tasks, thread_messages, message_threads,
                         recovery_plans, agent_constraints, approvals,
                         shipment_positions, run_scores, audit_events,
                         scenario_runs, incidents
                restart identity cascade""")
            # The baseline world, re-seeded.
            await conn.execute(sql)
            await _set_active_run(conn, None)

    set_run_context(None)
    CLOCK.reset()
    agent.forget_all()
    await HUB.broadcast({"kind": "world_reset", "mode": "hard", "clock": CLOCK.state()})
    return {"ok": True, "mode": "hard", "active_run": None,
            "cleared": ["test runs", "incidents", "decisions", "audit events",
                        "communications", "warehouse tasks", "approvals",
                        "evaluations", "scores", "supplier learning"],
            "kept": ["suppliers", "components", "warehouses", "policies",
                     "baseline inventory", "production orders"]}


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
        # Default scope is the ACTIVE RUN. Showing events from a run that has been
        # reset away, next to a freshly seeded world, is how the activity feed
        # came to narrate work that no longer existed.
        if since_reset and run_id is None and incident_id is None:
            run_id = await _active_run_id(conn)
            if run_id is None:
                return {"events": [], "scope": "no active run"}
        elif since_reset and run_id is None:
            after = max(after, await _reset_floor(conn))
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
        floor = await _reset_floor(conn)
        rejects = await conn.fetch(
            "select technical_payload->>'constraint' as c, count(*) as n from audit_events "
            "where event_type='OPTION_REJECTED' and sequence > $1 group by 1", floor)
        trust = await conn.fetchrow(
            "select round(avg(effective_reliability),3) as avg_trust, "
            "min(effective_reliability) as worst from supplier_effective")
        spark = await conn.fetch(
            "select date_trunc('minute', ts) as t, count(*) as n from audit_events "
            "where sequence > $1 group by 1 order by 1 desc limit 20", floor)
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
        # answer "and what did you do about it?", not just show a trust number —
        # but only for the world that exists now. Without the reset floor this
        # kept narrating a previous run's actions on a freshly reseeded graph.
        floor = await _reset_floor(conn)
        acts = await conn.fetch(
            """select technical_payload->>'supplier_id' as supplier_id,
                      event_type, human_summary, ts, sequence
                 from audit_events
                where technical_payload->>'supplier_id' is not null
                  and sequence > $1
                order by sequence desc limit 400""", floor)
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
        floor = await _reset_floor(conn)
        rejects = await conn.fetch(
            """select human_summary, technical_payload from audit_events
                where event_type='OPTION_REJECTED' and sequence > $1
                order by sequence desc limit 8""", floor)
        inv = await conn.fetch(
            """select c.display_name, i.usable_stock, i.erp_stock, i.daily_usage
                 from inventory i join components c on c.id=i.component_id""")
    state = {"open_incidents": [dict(r) for r in inc],
             "recent_plans": [dict(r) for r in plans],
             "recent_rejections": [r["human_summary"] for r in rejects],
             "inventory": [dict(r) for r in inv]}
    answer, used_llm = await llm.answer_question(body.question, state)

    # The numbers are built here, deterministically, and rendered as cards and
    # tables — not asked of the model and not parsed back out of prose. Two
    # reasons. A model that is unreachable still leaves you with the figures,
    # which is the half of the answer that matters. And a table of numbers the
    # model never touched cannot contain a number the model invented.
    blocks: list[dict[str, Any]] = []

    if inc:
        blocks.append({
            "kind": "facts",
            "title": "Open right now",
            "items": [{"label": r["id"], "value": r["component"] or "—",
                       "sub": f'{r["severity"]} · {r["status"].replace("_", " ")}'}
                      for r in inc],
        })

    if plans:
        blocks.append({
            "kind": "table",
            "title": "Options on the table",
            "columns": ["Option", "Cost", "Status"],
            "align": ["left", "right", "left"],
            "rows": [[p["label"],
                      f'\u20b9{float(p["total_cost"] or 0):,.0f}',
                      (p["status"] or "").replace("_", " ")] for p in plans],
            "note": "Scored by the deterministic solver. The model wrote none of these.",
        })

    tight = sorted(
        (dict(r) for r in inv if (r["daily_usage"] or 0) > 0),
        key=lambda r: r["usable_stock"] / r["daily_usage"])[:6]
    if tight:
        blocks.append({
            "kind": "table",
            "title": "Tightest cover",
            "columns": ["Component", "Usable", "ERP", "Days"],
            "align": ["left", "right", "right", "right"],
            "rows": [[r["display_name"], f'{r["usable_stock"]:,}', f'{r["erp_stock"]:,}',
                      f'{r["usable_stock"] / r["daily_usage"]:.1f}'] for r in tight],
            "note": "Where usable and ERP disagree, the agent uses usable — it is the "
                    "one that has been counted.",
        })

    if rejects:
        blocks.append({
            "kind": "list",
            "title": "What it refused, and why",
            "items": [r["human_summary"] for r in rejects[:6]],
        })

    # Say what the answer was formed from. An answer with no visible grounding is
    # indistinguishable from an answer that was made up.
    grounding = [f"{len(state['open_incidents'])} open incidents",
                 f"{len(state['recent_plans'])} recovery plans",
                 f"{len(state['recent_rejections'])} recorded refusals",
                 f"{len(state['inventory'])} components in stock"]
    return {"answer": answer, "llm": used_llm, "grounding": grounding, "blocks": blocks}


class CommandBody(BaseModel):
    instruction: str
    actor: str = "operator"


@app.post("/api/agent/command")
async def agent_command(body: CommandBody):
    """Tell the agent what to do.

    The second entry point into the one agent — `/api/agent/ask` reads and never
    writes, this acts. Every reply has the same shape (status, plan, blockers,
    alternatives, actions_taken) so the UI never has to guess whether anything
    happened. See command.py for why there is deliberately no second agent
    behind this.
    """
    if not (body.instruction or "").strip():
        raise HTTPException(400, "instruction is required")
    pool = await db()
    async with pool.acquire() as conn:
        try:
            return await command.run(conn, body.instruction, actor=body.actor)
        except ValueError as e:
            raise HTTPException(400, str(e))


@app.get("/api/llm/health")
async def llm_health():
    return await llm.health()


@app.get("/api/llm/diagnose")
async def llm_diagnose():
    """Why is the model unavailable? Try every provider and say what each did.

    "Deterministic only" is a symptom shared by a missing key, a revoked key, a
    model name that no longer exists and blocked egress — and the four fixes are
    entirely different. This answers which one it is.
    """
    return await llm.diagnose()


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
        # Tasks are things the agent asked for during a run, so they are scoped.
        # Inventory and inbound shipments below are the *world* — they exist
        # whether or not anyone has run a test, and the floor screen should
        # still show them.
        run_id = await _active_run_id(conn)
        tasks = await conn.fetch(
            """select w.*, c.display_name as component_name, c.part_number
                 from warehouse_tasks w left join components c on c.id=w.component_id
                where $1::bigint is not null and w.scenario_run_id = $1
                order by case w.status when 'open' then 0 when 'in_progress' then 1 else 2 end,
                         case w.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
                         w.id desc limit 40""", run_id)
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
        run_id = await _active_run_id(conn)
        if run_id is None:
            return {"approvals": [], "scope": "no active run"}
        rows = await conn.fetch(
            """select a.*, i.title, i.severity::text as severity,
                      c.display_name as component_name,
                      (select payload from recovery_plans rp
                        where rp.incident_id=a.incident_id order by rp.id desc limit 1) as plan
                 from approvals a
                 left join incidents i on i.id=a.incident_id
                 left join components c on c.id=i.component_id
                where a.scenario_run_id = $1
                order by case a.status when 'pending' then 0 else 1 end, a.id desc limit 30""",
            run_id)
    return {"approvals": [dict(r) for r in rows], "scope": run_id}


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
        # Same rule as everywhere else: with no run there is nothing to be right
        # or wrong about. A page reading "0% constraint compliance" against zero
        # orders is not a poor score, it is a claim about a thing that never
        # happened — and it is the reason this screen once reported that we had
        # failed at everything.
        if await _active_run_id(conn) is None:
            return {"measured": False, "active_run_id": None,
                    "reason": "No test run. Nothing has been asked of the agent yet, "
                              "so there is nothing to measure.",
                    "metrics": [], "violations": []}

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

        floor = await _reset_floor(conn)
        contradictions_real = await conn.fetchval(
            """select count(*) from shipment_tracking t
                where t.supplier_claim in ('dispatched','in_transit')
                  and t.tracking_status in ('label_created_no_pickup','not_shipped')""") or 0
        contradictions_caught = await conn.fetchval(
            "select count(*) from audit_events where event_type='CLAIM_CONTRADICTED' "
            "and sequence > $1", floor) or 0

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
                where event_type='MESSAGE_INTERPRETED' and sequence > $1""", floor)
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
        # No run means no evidence, and every field below is a claim about
        # something that happened. `production_at_risk` computed off the
        # baseline is the reason this screen once said "SHORT BY 460" in the
        # header and "nothing at risk" in the panel beside it: the shortfall was
        # real arithmetic about a world nobody had disrupted yet.
        # `null` is not `0`, and "no run" is not "all clear".
        active_run_id = await _active_run_id(conn)
        if active_run_id is None:
            return {
                "clock": CLOCK.state(),
                "active_run_id": None,
                "has_run": False,
                "queue": [],
                "incidents": [],
                "at_risk": [],
                "production_at_risk": False,
                "worst": None,
                "min_coverage_days": None,
                "agent_busy": 0,
                "next_delivery": None,
                "note": "No test run. The baseline topology is loaded; nothing has "
                        "happened to it yet.",
            }

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
        # Read from the audit log, not a parallel table. The event already carries
        # the question, the confidence and the options; duplicating it into its
        # own table would give the same fact two homes and one of them would rot.
        questions = await conn.fetch(
            """select h.id, h.incident_id, h.kind, h.question, h.detail,
                      h.confidence, h.options
                 from human_input_requests h
                where h.status = 'open' order by h.id desc limit 8""")
        drafts = await conn.fetch(
            """select m.id, m.thread_id, t.counterparty_name, t.subject
                 from thread_messages m
                 join message_threads t on t.id = m.thread_id
                where m.delivery_state = 'draft' order by m.id desc limit 8""")
        # Scoped to the active run. An incident from a run that has been reset
        # away is not "what is happening right now".
        incidents = await conn.fetch(
            """select i.id, i.status::text as status, i.severity::text as severity,
                      i.title, i.component_id, c.display_name as component_name
                 from incidents i
                 left join components c on c.id = i.component_id
                where i.status not in ('resolved','failed')
                  and ($1::bigint is null or i.scenario_run_id = $1)
                order by case i.severity::text when 'critical' then 0 when 'high' then 1
                                               when 'medium' then 2 else 3 end,
                         i.opened_at desc""", active_run_id)
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
    # A question the agent declined to answer outranks a warehouse count: it is
    # already blocked on you, and every minute it waits it is planning without
    # the thing it said it needed.
    for q in questions:
        queue.append({"kind": "question", "urgency": "critical",
                      "id": f"question-{q['id']}", "incident_id": q["incident_id"],
                      "request_id": q["id"],
                      "title": q["question"], "detail": q["detail"],
                      "confidence": float(q["confidence"] or 0),
                      "options": (json.loads(q["options"])
                                  if isinstance(q["options"], str) else (q["options"] or [])),
                      "cta": "Answer"})
    for d in drafts:
        queue.append({"kind": "draft", "urgency": "high", "id": f"draft-{d['id']}",
                      "message_id": d["id"], "thread_id": d["thread_id"],
                      "title": f"Draft waiting for you — {d['counterparty_name']}",
                      "detail": d["subject"], "cta": "Review and send"})
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
        # null, not 0. Every screen must show an empty state when there is no run.
        "active_run_id": active_run_id,
        "has_run": active_run_id is not None,
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
        # The floor screens are a separate actor with their own URL, and the
        # launcher cannot offer a facility it does not know exists.
        whs = await conn.fetch(
            "select id, name, city from warehouses order by id")
    return {"organization": dict(org) if org else None,
            "products": [dict(r) for r in prods],
            "warehouses": [dict(r) for r in whs],
            "production": [dict(r) for r in orders]}


# ====================== SUPPLIER PORTAL (third actor) ========================
#
# A supplier with a screen, not a timer with a script. See supplier_portal.py
# for why that distinction is the whole point.


class SupplierOffer(BaseModel):
    component_id: str
    quantity: int | None = None
    unit_price: float | None = None
    lead_time_days: int | None = None
    mode: str = "ROAD"
    min_order_quantity: int | None = None
    certifications: list[str] = []
    expedite_available: bool = False
    expedite_fee: float = 0
    freight_cost: float = 0


class SupplierReply(BaseModel):
    kind: str = "freeform"                 # quote | vague | decline | freeform
    thread_id: int | None = None
    body: str = ""
    note: str = ""
    offer: SupplierOffer | None = None


class SupplierClaim(BaseModel):
    po_id: str
    claim: str = "dispatched"
    note: str = ""


@app.get("/api/suppliers")
async def supplier_directory():
    pool = await db()
    async with pool.acquire() as conn:
        return {"suppliers": await supplier_portal.directory(conn),
                "staffed": supplier_portal.staffed()}


@app.get("/api/supplier/{supplier_id}")
async def supplier_view(supplier_id: str):
    pool = await db()
    async with pool.acquire() as conn:
        try:
            return await supplier_portal.overview(conn, supplier_id)
        except ValueError as e:
            raise HTTPException(404, str(e))


@app.post("/api/supplier/{supplier_id}/presence")
async def supplier_presence(supplier_id: str, leaving: bool = False):
    """Heartbeat from an open supplier portal.

    While this is warm the scripted persona for that supplier stands down and
    the agent genuinely waits for a person. Let it go cold and the personas
    resume, so an unattended demo still runs end to end.
    """
    if leaving:
        supplier_portal.leave(supplier_id)
    else:
        supplier_portal.heartbeat(supplier_id)
    return {"ok": True, "supplier_id": supplier_id,
            "staffed": supplier_portal.present(supplier_id),
            "all_staffed": supplier_portal.staffed()}


@app.post("/api/supplier/{supplier_id}/reply")
async def supplier_reply(supplier_id: str, body: SupplierReply):
    pool = await db()
    async with pool.acquire() as conn:
        try:
            return await supplier_portal.reply(
                conn, supplier_id, thread_id=body.thread_id, kind=body.kind,
                body=body.body, note=body.note,
                offer=body.offer.model_dump() if body.offer else None)
        except ValueError as e:
            raise HTTPException(400, str(e))


@app.post("/api/supplier/{supplier_id}/claim")
async def supplier_claim(supplier_id: str, body: SupplierClaim):
    """Let a person tell the lie. Catching a script proves nothing."""
    pool = await db()
    async with pool.acquire() as conn:
        try:
            return await supplier_portal.claim_dispatch(
                conn, supplier_id, po_id=body.po_id, claim=body.claim, note=body.note)
        except ValueError as e:
            raise HTTPException(400, str(e))


# ===================== THREAD AUTONOMY + DRAFTS ==============================


class AutonomyBody(BaseModel):
    mode: str                              # autonomous | draft | human
    by: str = "operator"


class SendDraftBody(BaseModel):
    body: str | None = None
    sent_by: str = "operator"


@app.post("/api/threads/{thread_id}/autonomy")
async def thread_autonomy(thread_id: int, body: AutonomyBody):
    pool = await db()
    async with pool.acquire() as conn:
        try:
            return await comms.set_autonomy(conn, thread_id, body.mode, by=body.by)
        except ValueError as e:
            raise HTTPException(400, str(e))


@app.post("/api/threads/messages/{message_id}/send")
async def send_draft(message_id: int, body: SendDraftBody):
    pool = await db()
    async with pool.acquire() as conn:
        try:
            return await comms.send_draft(conn, message_id, edited_body=body.body,
                                          sent_by=body.sent_by)
        except ValueError as e:
            raise HTTPException(400, str(e))


# ========================= HUMAN INPUT QUEUE =================================


class ResolveInput(BaseModel):
    choice: str
    note: str | None = None
    decided_by: str = "operator"


@app.get("/api/human-input")
async def human_input():
    """Questions the agent declined to answer, and what it did with the answers.

    Distinct from approvals on purpose. An approval is a decision the agent
    already made and may not execute. This is a decision it refused to make
    because the evidence would not carry it — which is the more interesting
    behaviour and, until now, the one nothing on screen rendered.
    """
    pool = await db()
    async with pool.acquire() as conn:
        # Same rule as everywhere else. A question the agent asked during a run
        # that no longer exists is not a question anyone can usefully answer.
        if await _active_run_id(conn) is None:
            return {"open": [], "recent": [], "scope": "no active run"}
        return {"open": await supplier_portal.open_requests(conn),
                "recent": await supplier_portal.recent_resolved(conn)}


@app.post("/api/human-input/{request_id}/resolve")
async def resolve_human_input(request_id: int, body: ResolveInput):
    pool = await db()
    async with pool.acquire() as conn:
        try:
            return await supplier_portal.resolve_human_input(
                conn, request_id, choice=body.choice, note=body.note,
                decided_by=body.decided_by)
        except ValueError as e:
            raise HTTPException(400, str(e))


# ======================== DECISION INTELLIGENCE ==============================


@app.get("/api/intelligence")
async def decision_intelligence(incident_id: str | None = None,
                                production_order_id: str | None = None):
    """Evidence → conclusion → action → why → confidence.

    The Decision Explorer is a comparison, which is what a procurement analyst
    wants. This is the brief, which is what the person who has to sign wants.
    Same rows underneath; different question.
    """
    pool = await db()
    async with pool.acquire() as conn:
        return await intelligence.brief(conn, incident_id=incident_id,
                                        production_order_id=production_order_id)


# ===================== TEST ENTITIES (build your own trap) ===================


class NewSupplier(BaseModel):
    name: str
    component_id: str
    unit_price: float
    lead_time_days: int = 3
    available_quantity: int = 500
    min_order_quantity: int = 1
    quality_score: float = 0.9
    reliability_score: float = 0.8
    certifications: list[str] = []
    city: str = "Pune"
    country: str = "India"
    mode: str = "ROAD"
    transit_days: int = 2
    freight_cost: float = 2000


@app.post("/api/world/suppliers")
async def create_test_supplier(body: NewSupplier):
    """Let somebody build their own trap without editing our seed file.

    "The cheapest supplier has no AEC-Q100" is a test a judge should be able to
    construct in thirty seconds. Anything created here is flagged `origin=test`
    and does not survive a reset, so one person's experiment cannot corrupt the
    next person's run.
    """
    if body.unit_price <= 0:
        raise HTTPException(400, "unit_price must be positive")
    if not (0 <= body.quality_score <= 1 and 0 <= body.reliability_score <= 1):
        raise HTTPException(400, "quality and reliability scores are 0–1")
    mode = body.mode.upper()
    if mode not in ("AIR", "SEA", "RAIL", "ROAD"):
        raise HTTPException(400, "mode must be AIR, SEA, RAIL or ROAD")

    pool = await db()
    async with pool.acquire() as conn:
        if not await conn.fetchval("select 1 from components where id=$1", body.component_id):
            raise HTTPException(404, f"unknown component {body.component_id}")
        n = await conn.fetchval("select count(*) from suppliers where origin='test'")
        sid = f"SUP-T{901 + int(n)}"
        await conn.execute(
            """insert into suppliers (id, name, email, city, country, quality_score,
                   reliability_score, certifications, origin)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'test')""",
            sid, body.name.strip()[:80], f"{sid.lower()}@test.example",
            body.city, body.country, body.quality_score, body.reliability_score,
            [c.upper() for c in body.certifications])
        await conn.execute(
            "insert into supplier_memory (supplier_id, derived_reliability) values ($1,$2)",
            sid, body.reliability_score)
        await conn.execute(
            """insert into supplier_lanes (supplier_id, warehouse_id, mode, transit_days,
                   freight_cost)
               values ($1,'Pune-Plant-1',$2::transport_mode,$3,$4)""",
            sid, mode, max(1, body.transit_days), body.freight_cost)
        await conn.execute(
            """insert into supplier_catalog (supplier_id, component_id, unit_price,
                   lead_time_days, available_quantity, min_order_quantity)
               values ($1,$2,$3,$4,$5,$6)""",
            sid, body.component_id, body.unit_price, max(0, body.lead_time_days),
            max(0, body.available_quantity), max(1, body.min_order_quantity))

        # Pune-Plant-1 has coordinates; a test supplier without them would vanish
        # from the network view rather than appear somewhere wrong.
        await conn.execute(
            "update suppliers set lat=18.62, lng=73.72, legal_name=$2 where id=$1",
            sid, body.name.strip()[:80])

        comp = await conn.fetchval(
            "select coalesce(display_name, name) from components where id=$1",
            body.component_id)
        need = await conn.fetchval(
            "select required_certifications from components where id=$1", body.component_id)
        missing = sorted(set(need or []) - {c.upper() for c in body.certifications})

        await emit(conn, actor="human", event_type="TEST_ENTITY_CREATED",
                   human_summary=(
                       f"Test supplier {body.name} added for {comp} at "
                       f"Rs {body.unit_price:g}/unit"
                       + (f" — missing {', '.join(missing)}, so the solver should refuse "
                          f"them on certification." if missing
                          else " — fully certified for this component.")),
                   payload={"supplier_id": sid, "component_id": body.component_id,
                            "missing_certifications": missing, "origin": "test"})
    await HUB.broadcast({"kind": "world_changed", "reason": "test_supplier_created"})
    return {"ok": True, "supplier_id": sid, "missing_certifications": missing,
            "note": ("This supplier disappears on the next reset, so it cannot "
                     "contaminate anybody else's run.")}


@app.delete("/api/world/suppliers/{supplier_id}")
async def delete_test_supplier(supplier_id: str):
    pool = await db()
    async with pool.acquire() as conn:
        origin = await conn.fetchval("select origin from suppliers where id=$1", supplier_id)
        if origin is None:
            raise HTTPException(404, f"unknown supplier {supplier_id}")
        if origin != "test":
            raise HTTPException(
                403, "only suppliers created from the scenario builder can be removed — "
                     "seeded ones come back on reset anyway")
        await conn.execute("delete from suppliers where id=$1", supplier_id)
    return {"ok": True, "removed": supplier_id}


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
