"""Scenario injector — applies disruption events to the live database.

Every event does two things: mutate operational state, and emit an audit
event that streams to the dashboard. If it isn't in audit_events, it didn't
happen.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from .core import CLOCK, broadcast_state, db, emit, next_incident_id
from .scenarios import SCENARIOS

_running: dict[str, asyncio.Task] = {}


# ------------------------------------------------------------ appliers -----


async def _ensure_incident(conn, *, itype: str, component_id: str | None,
                           po_id: str | None, severity: str = "medium") -> str:
    existing = await conn.fetchval(
        "select id from incidents where status not in ('resolved','failed') "
        "and (source_po_id = $1 or ($1 is null and component_id = $2)) limit 1",
        po_id, component_id,
    )
    if existing:
        return existing
    iid = await next_incident_id(conn)
    await conn.execute(
        """insert into incidents (id, type, severity, status, component_id,
                                  source_po_id, thread_id)
           values ($1,$2,$3::severity_level,'open',$4,$5,$1)""",
        iid, itype, severity, component_id, po_id,
    )
    await emit(conn, incident_id=iid, actor="injector", event_type="INCIDENT_OPENED",
               human_summary=f"Incident {iid} opened: {itype}.",
               payload={"type": itype, "component_id": component_id, "po_id": po_id})
    await broadcast_state("incident_opened", {"incident_id": iid})
    return iid


async def apply_event(conn, etype: str, params: dict[str, Any],
                      incident_id: str | None = None) -> dict[str, Any]:
    """Apply one disruption event. Returns {incident_id, summary}."""

    if etype == "supplier_delay":
        po_id = params["po_id"]
        days = int(params.get("delay_days", 5))
        po = await conn.fetchrow(
            "select component_id, supplier_id, expected_delivery from purchase_orders where id=$1",
            po_id)
        if po is None:
            raise ValueError(f"unknown po_id {po_id}")
        await conn.execute(
            """update purchase_orders
                  set status='delayed',
                      expected_delivery = expected_delivery + ($2 || ' days')::interval
                where id=$1""", po_id, str(days))
        await conn.execute(
            """insert into messages (incident_id, direction, supplier_id, subject, body)
               values ($1,'inbound',$2,$3,$4)""",
            incident_id, po["supplier_id"], f"Delay on {po_id}",
            params.get("body",
                       f"Due to transport issues, delivery may be delayed by "
                       f"{days}-{days + 2} days. We are trying to resolve this."))
        await conn.execute(
            """update supplier_memory
                  set promises_made = promises_made + 1,
                      avg_delay_days = (avg_delay_days + $2) / 2,
                      updated_at = now()
                where supplier_id = $1""", po["supplier_id"], days)
        iid = incident_id or await _ensure_incident(
            conn, itype="supplier_delay", component_id=po["component_id"],
            po_id=po_id, severity="high")
        summary = (f"{po['supplier_id']} delayed {po_id} by ~{days} days "
                   f"({po['component_id']}).")
        await emit(conn, incident_id=iid, actor="injector",
                   event_type="DISRUPTION_INJECTED", human_summary=summary,
                   payload={"event": etype, **params, "component_id": po["component_id"]})
        return {"incident_id": iid, "summary": summary}

    if etype == "inventory_correction":
        cid, usable = params["component_id"], int(params["usable_stock"])
        prev = await conn.fetchrow(
            "select erp_stock, usable_stock from inventory where component_id=$1", cid)
        await conn.execute(
            """update inventory set usable_stock=$2, last_updated=now()
                where component_id=$1""", cid, usable)
        iid = incident_id or await _ensure_incident(
            conn, itype="inventory_discrepancy", component_id=cid, po_id=None,
            severity="high")
        summary = (f"Physical count for {cid}: {usable} usable vs {prev['erp_stock']} "
                   f"in ERP (was {prev['usable_stock']}).")
        await emit(conn, incident_id=iid, actor="injector",
                   event_type="INVENTORY_DISCREPANCY", human_summary=summary,
                   payload={"component_id": cid, "erp_stock": prev["erp_stock"],
                            "usable_stock": usable,
                            "previous_usable": prev["usable_stock"]})
        return {"incident_id": iid, "summary": summary}

    if etype == "supplier_claim":
        po_id, claim = params["po_id"], params.get("claim", "dispatched")
        sup = await conn.fetchval("select supplier_id from purchase_orders where id=$1", po_id)
        await conn.execute(
            """insert into shipment_tracking (po_id, supplier_claim, updated_at)
               values ($1,$2,now())
               on conflict (po_id) do update set supplier_claim=$2, updated_at=now()""",
            po_id, claim)
        await conn.execute(
            """insert into messages (incident_id, direction, supplier_id, subject, body)
               values ($1,'inbound',$2,$3,$4)""",
            incident_id, sup, f"Update on {po_id}",
            params.get("body", f"Shipment for {po_id} has been {claim}."))
        iid = incident_id or await _ensure_incident(
            conn, itype="supplier_claim", component_id=None, po_id=po_id)
        summary = f"{sup} claims {po_id} is '{claim}'."
        await emit(conn, incident_id=iid, actor="injector",
                   event_type="SUPPLIER_CLAIM", human_summary=summary,
                   payload={"po_id": po_id, "supplier_id": sup, "claim": claim})
        return {"incident_id": iid, "summary": summary}

    if etype == "tracking_state":
        po_id = params["po_id"]
        status = params.get("tracking_status", "label_created_no_pickup")
        await conn.execute(
            """insert into shipment_tracking (po_id, tracking_status, last_movement, updated_at)
               values ($1,$2,$3,now())
               on conflict (po_id) do update
                 set tracking_status=$2, last_movement=$3, updated_at=now()""",
            po_id, status, params.get("last_movement"))
        row = await conn.fetchrow(
            "select supplier_claim, tracking_status from shipment_tracking where po_id=$1", po_id)
        contradiction = (row["supplier_claim"] in ("dispatched", "in_transit")
                         and status in ("label_created_no_pickup", "not_shipped"))
        iid = incident_id or await _ensure_incident(
            conn, itype="tracking_contradiction", component_id=None, po_id=po_id,
            severity="critical" if contradiction else "medium")
        if contradiction:
            sup = await conn.fetchval(
                "select supplier_id from purchase_orders where id=$1", po_id)
            await conn.execute(
                """update supplier_memory
                      set contradictions_detected = contradictions_detected + 1,
                          derived_reliability = greatest(0.05, derived_reliability - 0.25),
                          updated_at = now()
                    where supplier_id = $1""", sup)
            summary = (f"CONTRADICTION on {po_id}: supplier claims "
                       f"'{row['supplier_claim']}' but carrier shows '{status}'.")
            await emit(conn, incident_id=iid, actor="injector",
                       event_type="CLAIM_CONTRADICTED", human_summary=summary,
                       payload={"po_id": po_id, "supplier_id": sup,
                                "supplier_claim": row["supplier_claim"],
                                "tracking_status": status,
                                "reliability_penalty": 0.25})
        else:
            summary = f"Tracking for {po_id} is now '{status}'."
            await emit(conn, incident_id=iid, actor="injector",
                       event_type="TRACKING_UPDATED", human_summary=summary,
                       payload={"po_id": po_id, "tracking_status": status})
        return {"incident_id": iid, "summary": summary}

    if etype == "demand_spike":
        cid, usage = params["component_id"], int(params["daily_usage"])
        prev = await conn.fetchval(
            "select daily_usage from inventory where component_id=$1", cid)
        await conn.execute(
            "update inventory set daily_usage=$2, last_updated=now() where component_id=$1",
            cid, usage)
        iid = incident_id or await _ensure_incident(
            conn, itype="demand_spike", component_id=cid, po_id=None, severity="high")
        summary = f"Demand for {cid} jumped {prev} -> {usage} units/day."
        await emit(conn, incident_id=iid, actor="injector", event_type="DEMAND_SPIKE",
                   human_summary=summary,
                   payload={"component_id": cid, "previous": prev, "current": usage})
        return {"incident_id": iid, "summary": summary}

    if etype == "priority_change":
        pid, pr = params["production_order_id"], params["priority"]
        await conn.execute(
            "update production_orders set priority=$2::order_priority where id=$1", pid, pr)
        comp = await conn.fetchval(
            "select required_component from production_orders where id=$1", pid)
        iid = incident_id or await _ensure_incident(
            conn, itype="priority_change", component_id=comp, po_id=None)
        summary = f"{pid} priority raised to {pr}."
        await emit(conn, incident_id=iid, actor="injector", event_type="PRIORITY_CHANGED",
                   human_summary=summary, payload={"production_order_id": pid, "priority": pr})
        return {"incident_id": iid, "summary": summary}

    if etype == "deadline_pull_in":
        pid = params["production_order_id"]
        hours = float(params.get("hours_from_now", 12))
        new_deadline = CLOCK.now() + timedelta(hours=hours)
        await conn.execute(
            "update production_orders set deadline=$2 where id=$1", pid, new_deadline)
        comp = await conn.fetchval(
            "select required_component from production_orders where id=$1", pid)
        iid = incident_id or await _ensure_incident(
            conn, itype="deadline_pulled_in", component_id=comp, po_id=None,
            severity="critical")
        summary = f"{pid} deadline pulled in to {hours:.0f}h from now."
        await emit(conn, incident_id=iid, actor="injector", event_type="DEADLINE_PULLED_IN",
                   human_summary=summary,
                   payload={"production_order_id": pid, "hours_from_now": hours,
                            "new_deadline": new_deadline.isoformat()})
        return {"incident_id": iid, "summary": summary}

    if etype == "quality_failure":
        sid, q = params["supplier_id"], float(params["new_quality_score"])
        await conn.execute("update suppliers set quality_score=$2 where id=$1", sid, q)
        await conn.execute(
            """update supplier_memory
                  set quality_failures = quality_failures + 1,
                      derived_reliability = greatest(0.05, derived_reliability - 0.15),
                      updated_at = now()
                where supplier_id=$1""", sid)
        iid = incident_id or await _ensure_incident(
            conn, itype="quality_failure", component_id=None, po_id=None, severity="high")
        summary = f"{sid} failed incoming inspection; quality score now {q}."
        await emit(conn, incident_id=iid, actor="injector", event_type="QUALITY_FAILURE",
                   human_summary=summary, payload={"supplier_id": sid, "quality_score": q})
        return {"incident_id": iid, "summary": summary}

    if etype == "expedite_unavailable":
        await conn.execute(
            """insert into system_config (key, value) values ('expedite_available','false'::jsonb)
               on conflict (key) do update set value='false'::jsonb""")
        iid = incident_id or await _ensure_incident(
            conn, itype="expedite_unavailable", component_id=None, po_id=None)
        summary = f"Expedited shipping unavailable: {params.get('reason','carrier capacity')}"
        await emit(conn, incident_id=iid, actor="injector",
                   event_type="EXPEDITE_UNAVAILABLE", human_summary=summary, payload=params)
        return {"incident_id": iid, "summary": summary}

    if etype == "hazmat_disruption":
        po_id = params["po_id"]
        po = await conn.fetchrow(
            "select component_id, supplier_id from purchase_orders where id=$1", po_id)
        await conn.execute("update purchase_orders set status='cancelled' where id=$1", po_id)
        iid = incident_id or await _ensure_incident(
            conn, itype="hazmat_supply_failure", component_id=po["component_id"],
            po_id=po_id, severity="critical")
        summary = (f"{po_id} cancelled by {po['supplier_id']}. {po['component_id']} is "
                   f"hazmat - air freight is not a legal fallback.")
        await emit(conn, incident_id=iid, actor="injector",
                   event_type="HAZMAT_SUPPLY_FAILURE", human_summary=summary,
                   payload={"po_id": po_id, "component_id": po["component_id"],
                            "constraint": "HAZMAT_NO_AIR"})
        return {"incident_id": iid, "summary": summary}

    raise ValueError(f"unknown event type '{etype}'")


# ------------------------------------------------------------- runners -----


async def _run(scenario_id: str, run_id: int) -> None:
    sc = SCENARIOS[scenario_id]
    pool = await db()
    start = CLOCK.elapsed_sim_hours()
    try:
        for ev in sorted(sc["events"], key=lambda e: e.get("at_h", 0)):
            target = start + float(ev.get("at_h", 0))
            while CLOCK.elapsed_sim_hours() < target:
                await asyncio.sleep(0.2)
            async with pool.acquire() as conn:
                await apply_event(conn, ev["type"], ev.get("params", {}))
        async with pool.acquire() as conn:
            await conn.execute(
                "update scenario_runs set finished_at=now() where id=$1", run_id)
        await broadcast_state("scenario_finished", {"scenario_id": scenario_id,
                                                    "run_id": run_id})
    except asyncio.CancelledError:
        await broadcast_state("scenario_cancelled", {"scenario_id": scenario_id})
        raise
    finally:
        _running.pop(scenario_id, None)


async def inject(scenario_id: str) -> dict[str, Any]:
    if scenario_id not in SCENARIOS:
        raise ValueError(f"unknown scenario '{scenario_id}'")
    if scenario_id in _running:
        raise ValueError(f"'{scenario_id}' is already running")
    pool = await db()
    async with pool.acquire() as conn:
        run_id = await conn.fetchval(
            "insert into scenario_runs (scenario_id) values ($1) returning id", scenario_id)
        await emit(conn, actor="injector", event_type="SCENARIO_STARTED",
                   human_summary=f"Scenario {scenario_id} injected: "
                                 f"{SCENARIOS[scenario_id]['title']}",
                   payload={"scenario_id": scenario_id, "run_id": run_id})
    _running[scenario_id] = asyncio.create_task(_run(scenario_id, run_id))
    await broadcast_state("scenario_started",
                          {"scenario_id": scenario_id, "run_id": run_id})
    return {"scenario_id": scenario_id, "run_id": run_id, "status": "running"}


def running() -> list[str]:
    return list(_running.keys())


async def stop_all() -> None:
    for task in list(_running.values()):
        task.cancel()
    _running.clear()
