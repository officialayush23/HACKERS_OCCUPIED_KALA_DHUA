"""Agent orchestrator.

    MONITOR → DETECT → TRIAGE → INVESTIGATE → COMMUNICATE → PLAN → VALIDATE
        → APPROVE? ──no──→ EXECUTE → VERIFY → MONITOR
                  └─yes──→ HUMAN → RESUME → EXECUTE → …

An explicit async state machine rather than LangGraph: same graph shape,
same interrupt/resume semantics, zero install risk on a hackathon laptop.
`_STATE` is the checkpoint store; `resume()` is the interrupt exit.

Division of labour, enforced by construction:
  - deterministic code   : coverage, shortfall, MOQ, certification, cost, policy
  - the LLM (`llm.py`)   : reading vague messages, contradiction reasoning, prose

Every node emits an audit event with a plain-English `human_summary`, so the
Command Center reads like a person narrating their work.
"""
from __future__ import annotations

import asyncio
import logging
import traceback
import json
from typing import Any

from . import comms, learning, llm
from .core import (APPROVAL_THRESHOLD_INR, CLOCK, broadcast_state, db, emit,
                   next_incident_id, run_context)

logger = logging.getLogger("disruptionops.agent")
from .risk import assess
from .solver import solve_for_production_order

MAX_TOOL_CALLS = 12

#: incident_id -> live state. The checkpoint.
_STATE: dict[str, dict[str, Any]] = {}
_RUNNING: dict[str, asyncio.Task] = {}


def forget_all() -> None:
    """Drop every in-memory checkpoint.

    A hard reset that empties the database but leaves the agent holding state
    for incidents that no longer exist produces exactly the ghosts it was meant
    to remove.
    """
    _STATE.clear()


def state_of(incident_id: str) -> dict[str, Any] | None:
    return _STATE.get(incident_id)


def all_states() -> dict[str, Any]:
    return _STATE


# --------------------------------------------------------------- helpers ----


async def _step(conn, incident_id: str, label: str, *, status: str = "done",
                detail: dict | None = None) -> None:
    """One line in the human-readable 'agent is working' feed."""
    st = _STATE.setdefault(incident_id, {})
    st.setdefault("steps", []).append({"label": label, "status": status,
                                       "at": CLOCK.now().isoformat()})
    await emit(conn, incident_id=incident_id, actor="agent",
               event_type="AGENT_STEP", human_summary=label,
               payload={"status": status, **(detail or {})})
    await broadcast_state("agent_step",
                          {"incident_id": incident_id, "label": label, "status": status})


# The database enum, mirrored. Two values in this file were never members of it
# — "monitoring" and "reopened" — and each one killed the agent at the very last
# step of an otherwise successful run: plan chosen, order raised, then a crash
# on the status update. Duplicating the list here is worth it because the
# assertion below turns a runtime 500 deep in a background task into a loud,
# obvious failure the first time anyone runs that path.
INCIDENT_STATUSES = frozenset({
    "open", "investigating", "planning", "awaiting_approval",
    "executing", "verifying", "resolved", "failed",
})


async def _set_status(conn, incident_id: str, status: str) -> None:
    if status not in INCIDENT_STATUSES:
        raise ValueError(
            f"{status!r} is not an incident_status. Valid values are "
            f"{sorted(INCIDENT_STATUSES)}. Add it to the enum in a migration "
            f"before using it here.")
    await conn.execute("update incidents set status=$2::incident_status where id=$1",
                       incident_id, status)
    _STATE.setdefault(incident_id, {})["status"] = status
    await broadcast_state("incident_status", {"incident_id": incident_id, "status": status})


async def _constraints(conn, incident_id: str) -> list[dict]:
    rows = await conn.fetch(
        "select * from agent_constraints where active and (incident_id=$1 or incident_id is null)",
        incident_id)
    return [dict(r) for r in rows]


# ------------------------------------------------------------ the graph ----


async def wake(conn, *, component_id: str, trigger: str,
               po_id: str | None = None) -> str | None:
    """DETECT + TRIAGE. Returns the incident id if the agent took ownership."""
    verdict = await assess(conn, component_id, trigger=trigger)

    # Show the working. "Short by 160" on one run and "short by 460" on the next
    # looks like the system disagreeing with itself unless the inputs are
    # attached to the number — they are different worlds, not different opinions.
    w = verdict.threatened[0] if verdict.threatened else None
    await emit(conn, actor="risk_detector", event_type="RISK_ASSESSED",
               human_summary=verdict.headline,
               agent_reason=(
                   f"required {w.required_units} "
                   f"- usable {w.usable_stock} "
                   f"+ safety {w.safety_stock} "
                   f"- inbound landing before the deadline {w.incoming_before_deadline} "
                   f"= {w.shortfall} short. ERP says {w.erp_stock}; I used the "
                   f"warehouse figure, not the ERP one, because only one of them has "
                   f"been counted."
                   if w else
                   "No production order is short once inbound stock is counted."),
               payload=verdict.to_dict())

    if not verdict.threatens_production:
        return None

    existing = await conn.fetchval(
        "select id from incidents where component_id=$1 "
        "and status not in ('resolved','failed') order by opened_at desc limit 1",
        component_id)

    if existing:
        incident_id = existing
        await conn.execute(
            "update incidents set severity=$2::severity_level, title=$3 where id=$1",
            incident_id, verdict.severity, verdict.headline)
    else:
        incident_id = await next_incident_id(conn)
        await conn.execute(
            """insert into incidents (id, type, severity, status, component_id, source_po_id,
                                      thread_id, title, details, scenario_run_id)
               values ($1,'production_risk',$2::severity_level,'open',$3,$4,$1,$5,$6::jsonb,$7)""",
            incident_id, verdict.severity, component_id, po_id, verdict.headline,
            json.dumps({"trigger": trigger, "verdict": verdict.to_dict()}, default=str),
            (run_context() or {}).get("run_id"))
        await emit(conn, incident_id=incident_id, actor="risk_detector",
                   event_type="INCIDENT_OPENED",
                   human_summary=f"Opened automatically — {verdict.headline}",
                   agent_reason=(
                       f"Coverage for {component_id} fell to "
                       f"{verdict.coverage_days:.1f} days against the deadline, which is "
                       f"inside the {verdict.severity} threshold. I opened this myself "
                       f"rather than wait to be asked — nobody pressed anything."),
                   payload={"severity": verdict.severity, "auto": True,
                            "coverage_days": verdict.coverage_days})

    _STATE[incident_id] = {
        "incident_id": incident_id, "component_id": component_id,
        "component_name": verdict.component_name, "severity": verdict.severity,
        "headline": verdict.headline, "coverage_days": verdict.coverage_days,
        "threatened": [t.__dict__ for t in verdict.threatened],
        "steps": [], "tool_calls": 0, "status": "open",
        "run_id": (run_context() or {}).get("run_id"),
    }

    await broadcast_state("agent_woke", {"incident_id": incident_id})

    if incident_id not in _RUNNING:
        _RUNNING[incident_id] = asyncio.create_task(_run(incident_id))
    return incident_id


async def _run(incident_id: str) -> None:
    """One pass of the loop, with an honest ending in every branch.

    This used to swallow a crash into a single AGENT_STEP labelled "Agent hit an
    error" and then return. The incident stayed in `investigating` forever, so
    the dashboard reported "Still deciding" indefinitely and every downstream
    screen — decisions, evaluation, accuracy — sat at zero with no explanation.
    A run that died looked exactly like a run that was thinking.

    An agent that stops must say so, in the same log as everything else.
    """
    pool = await db()
    try:
        async with pool.acquire() as conn:
            await emit(conn, incident_id=incident_id, actor="agent",
                       event_type="AGENT_RUN_STARTED",
                       human_summary="Agent picked up the incident.",
                       agent_reason=("Investigate, then contact, then plan. The order is "
                                     "fixed: I do not ask a supplier for a price before I "
                                     "know what I am short of."),
                       payload={"incident_id": incident_id})
            await _investigate(conn, incident_id)
            await _communicate(conn, incident_id)
            await _plan_and_validate(conn, incident_id)
            await emit(conn, incident_id=incident_id, actor="agent",
                       event_type="AGENT_RUN_FINISHED",
                       human_summary="Agent finished this pass.",
                       payload={"incident_id": incident_id})
    except asyncio.CancelledError:
        raise
    except Exception as exc:                       # noqa: BLE001
        trace = traceback.format_exc()
        logger.exception("agent run failed for %s", incident_id)
        pool2 = await db()
        async with pool2.acquire() as conn:
            await _step(conn, incident_id, f"Agent stopped: {exc}", status="error")
            # A distinct event type, so the UI can say "this run failed" rather
            # than leaving a spinner up. The traceback goes in the technical
            # projection — a judge reading the Technical tab should see the
            # actual failure, not a sanitised version of it.
            await emit(conn, incident_id=incident_id, actor="agent",
                       event_type="AGENT_FAILED",
                       human_summary=f"The agent stopped before finishing: {exc}",
                       agent_reason=("I could not complete this pass. Reporting the stop is "
                                     "the correct behaviour — continuing to display "
                                     "'still deciding' would be a claim that I am still "
                                     "working on it, and I am not."),
                       payload={"incident_id": incident_id, "error": str(exc),
                                "error_type": type(exc).__name__, "traceback": trace})
            try:
                await conn.execute(
                    "update incidents set status='failed' where id=$1", incident_id)
            except Exception:                      # noqa: BLE001
                pass
    finally:
        _RUNNING.pop(incident_id, None)


async def _investigate(conn, incident_id: str) -> None:
    """Mandatory evidence pack in PARALLEL, then LLM gap analysis.

    The evidence pack is not a choice. Asking a model whether inventory matters
    to an inventory shortage is latency, not intelligence.
    """
    st = _STATE[incident_id]
    cid = st["component_id"]
    await _set_status(conn, incident_id, "investigating")
    await _step(conn, incident_id, "Picked up the incident and started investigating.")

    # TRUE parallelism: one pooled connection each. asyncpg forbids concurrent
    # operations on a single connection, so gather() over `conn` would deadlock.
    pool = await db()

    async def q(sql: str, one: bool = False):
        async with pool.acquire() as c:
            return await (c.fetchrow(sql, cid) if one else c.fetch(sql, cid))

    inv, prod, pos, sup = await asyncio.gather(
        q("""select i.*, c.display_name, c.part_number
               from inventory i join components c on c.id=i.component_id
              where i.component_id=$1""", one=True),
        q("""select po.*, pr.name as product_name from production_orders po
               left join products pr on pr.id=po.product_id
              where po.required_component=$1 order by po.deadline"""),
        q("""select p.*, t.supplier_claim, t.tracking_status from purchase_orders p
               left join shipment_tracking t on t.po_id=p.id
              where p.component_id=$1 and p.status in ('open','in_transit','delayed')"""),
        q("""select se.* from supplier_effective se
               join supplier_catalog sc on sc.supplier_id=se.supplier_id
              where sc.component_id=$1"""),
    )
    st["tool_calls"] += 4

    name = (inv["display_name"] if inv else cid) or cid
    st["component_name"] = name
    cover = round(int(inv["usable_stock"]) / max(int(inv["daily_usage"]), 1), 1) if inv else 0
    st["coverage_days"] = cover

    await _step(conn, incident_id,
                f"Checked usable inventory — {inv['usable_stock']} units of {name} on hand.",
                detail={"usable": inv["usable_stock"], "erp": inv["erp_stock"]})

    if inv and int(inv["erp_stock"]) != int(inv["usable_stock"]):
        gap = int(inv["erp_stock"]) - int(inv["usable_stock"])
        await _step(conn, incident_id,
                    f"ERP overstates stock by {gap} units. Using the warehouse figure, not ERP.",
                    detail={"erp_gap": gap})

    await _step(conn, incident_id,
                f"Calculated {cover} days of production cover at current consumption.")

    # Conditional: only verify shipments if there are any in flight
    contradictions = []
    for p in pos:
        if p["supplier_claim"] in ("dispatched", "in_transit") and \
           p["tracking_status"] in ("label_created_no_pickup", "not_shipped"):
            contradictions.append(dict(p))

    if pos:
        st["tool_calls"] += 1
        await _step(conn, incident_id,
                    f"Verified {len(pos)} inbound shipment(s) against carrier tracking.")

    for c in contradictions:
        sup_name = await conn.fetchval(
            "select coalesce(legal_name, name) from suppliers where id=$1", c["supplier_id"])
        verdict, used_llm = await llm.assess_contradiction(
            c["supplier_claim"], c["tracking_status"], sup_name or c["supplier_id"])
        st["confidence"] = "low"
        await conn.execute(
            "update incidents set confidence='low' where id=$1", incident_id)
        await learning.record(
            conn, c["supplier_id"], "contradiction",
            incident_id=incident_id,
            reason=(f"Claimed '{c['supplier_claim']}' on {c['id']} while the carrier "
                    f"showed '{c['tracking_status']}'."),
            detail={"po_id": c["id"]})
        await emit(conn, incident_id=incident_id, actor="agent",
                   event_type="CLAIM_CONTRADICTED",
                   human_summary=verdict["reasoning"],
                   payload={**verdict, "po_id": c["id"], "supplier_id": c["supplier_id"],
                            "llm": used_llm})
        await _step(conn, incident_id,
                    f"{sup_name} says '{c['supplier_claim']}' but the carrier shows "
                    f"'{c['tracking_status']}'. Treating that shipment as unreliable.",
                    status="warning")

    st["contradictions"] = contradictions
    st["suppliers_available"] = len(sup)


async def _communicate(conn, incident_id: str) -> None:
    """Agent writes to the supplier who failed, the warehouse, and alternates."""
    st = _STATE[incident_id]
    cid, name = st["component_id"], st["component_name"]

    # 1. Press the incumbent
    for c in st.get("contradictions", []):
        await comms.agent_message_supplier(
            conn, incident_id=incident_id, supplier_id=c["supplier_id"],
            kind="delay_confirmation",
            context={"po_id": c["id"], "component_name": name})
        st["tool_calls"] += 1
        await _step(conn, incident_id,
                    f"Asked {c['supplier_id']} to confirm actual carrier pickup time.")

    # 2. Ask the warehouse for physical truth
    inv = await conn.fetchrow("select * from inventory where component_id=$1", cid)
    if inv and int(inv["erp_stock"]) != int(inv["usable_stock"]):
        await comms.agent_request_warehouse(
            conn, incident_id=incident_id, component_id=cid,
            task_type="usable_stock_verification",
            context={"component_name": name, "erp_stock": inv["erp_stock"],
                     "coverage_days": st.get("coverage_days")})
        st["tool_calls"] += 1
        await _step(conn, incident_id, "Raised a warehouse task to verify usable stock.")

    # 3. Parallel RFQs to alternates
    alts = await conn.fetch(
        """select sc.supplier_id, se.name from supplier_catalog sc
             join supplier_effective se on se.supplier_id=sc.supplier_id
            where sc.component_id=$1 order by se.effective_reliability desc limit 3""", cid)
    if alts:
        pool = await db()

        async def rfq(supplier_id: str):
            # Own connection per RFQ — this is genuinely concurrent, not a loop.
            async with pool.acquire() as c:
                return await comms.agent_message_supplier(
                    c, incident_id=incident_id, supplier_id=supplier_id, kind="rfq",
                    context={"component_name": name,
                             "quantity": max(1, int((st.get("coverage_days") or 1) * 100)),
                             "needed_by": "the current production deadline"})

        await asyncio.gather(*[rfq(a["supplier_id"]) for a in alts])
        st["tool_calls"] += len(alts)
        await _step(conn, incident_id,
                    f"Sent parallel RFQs to {len(alts)} alternate suppliers "
                    f"({', '.join(a['supplier_id'] for a in alts)}).")


async def _plan_and_validate(conn, incident_id: str) -> None:
    """PLAN (deterministic) → VALIDATE → policy gate → execute or escalate."""
    st = _STATE[incident_id]
    await _set_status(conn, incident_id, "planning")

    order = await conn.fetchval(
        """select po.id from production_orders po
            where po.required_component=$1 and po.is_on_hold=false
            order by case po.priority when 'critical' then 0 when 'high' then 1
                                      when 'medium' then 2 else 3 end, po.deadline limit 1""",
        st["component_id"])
    if not order:
        await _step(conn, incident_id, "No active production order to recover.", status="error")
        return

    excluded = {c["target"] for c in await _constraints(conn, incident_id)
                if c["constraint_type"] == "exclude_supplier"}

    result = await solve_for_production_order(conn, order)
    st["tool_calls"] += 1

    if excluded:
        result["options"] = [o for o in result["options"]
                             if not any(l["supplier_id"] in excluded for l in o.get("lines", []))]
        result["chosen"] = result["options"][0] if result["options"] else None
        await _step(conn, incident_id,
                    f"Applied human constraint — excluded {', '.join(sorted(excluded))}.")

    for rej in result.get("rejections", []):
        await emit(conn, incident_id=incident_id, actor="solver",
                   event_type="OPTION_REJECTED", human_summary=rej["human_reason"],
                   agent_reason=(
                       f"{rej['supplier_id']} was removed before scoring. "
                       f"{rej['constraint']} is a hard filter, not a weighting — no price "
                       f"or lead time can compensate for it."),
                   payload={"supplier_id": rej["supplier_id"],
                            "constraint": rej["constraint"], **rej.get("detail", {})})

    chosen = result.get("chosen")
    if not chosen:
        await _step(conn, incident_id,
                    "No option satisfies every hard constraint. Escalating to a human.",
                    status="error")
        await _set_status(conn, incident_id, "awaiting_approval")
        return

    await _step(conn, incident_id,
                f"Evaluated {len(result['options'])} recovery options, "
                f"rejected {len(result['rejections'])} on hard constraints.")

    # Human-readable reasoning
    comp = await conn.fetchrow(
        """select c.display_name, c.part_number,
                  (select pr.name from production_orders po
                     left join products pr on pr.id=po.product_id where po.id=$2) as product_name
             from components c where c.id=$1""", st["component_id"], order)
    narrative, used_llm = await llm.explain_decision({
        "component_name": comp["display_name"], "part_number": comp["part_number"],
        "product_name": comp["product_name"], "shortfall": result["shortfall"],
        "coverage_days": st.get("coverage_days"),
        "chosen": chosen, "rejections": result["rejections"],
    })
    await conn.execute("update incidents set narrative=$2 where id=$1", incident_id, narrative)

    plan_id = await conn.fetchval(
        """insert into recovery_plans
             (incident_id,status,option_kind,label,total_cost,score,rationale,
              requires_approval,payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning id""",
        incident_id,
        "awaiting_approval" if chosen["requires_approval"] else "approved",
        chosen["kind"], chosen["label"], chosen["total_cost"], chosen["score"],
        narrative, chosen["requires_approval"],
        json.dumps({"chosen": chosen, "options": result["options"],
                    "rejections": result["rejections"]}, default=str))

    st["plan_id"] = plan_id
    st["result"] = result
    st["narrative"] = narrative

    await emit(conn, incident_id=incident_id, actor="agent", event_type="OPTION_SELECTED",
               human_summary=f"Recovery plan: {chosen['label']} — "
                             f"Rs {chosen['total_cost']:,.0f}.",
               agent_reason=(
                   f"Scored {len(result['options'])} option(s) on continuity 0.35, cost 0.20 "
                   f"and supplier risk 0.15. {chosen['label']} scored {chosen['score']:.3f}: "
                   f"covers {chosen['units_covered']} of {result['shortfall']} units, "
                   f"arrives in {(chosen['arrival_hours'] or 0)/24:.1f} days. "
                   f"{len(result['rejections'])} option(s) never reached scoring because they "
                   f"failed a hard constraint."),
               payload={**chosen, "plan_id": plan_id, "llm_narrative": used_llm})

    # ---- policy gate -------------------------------------------------------
    if chosen["requires_approval"]:
        await _set_status(conn, incident_id, "awaiting_approval")
        imp = chosen.get("impact")
        if chosen.get("kind") == "reschedule_other" and imp:
            reason = (f"Delays {imp['product_name']} for {imp['oem_customer']} by "
                      f"{imp['delay_days']} days")
            blocked_line = (
                f"This costs almost nothing in money and {imp['delay_days']} days of "
                f"{imp['oem_customer']}'s time. Delaying another customer is not mine "
                f"to decide. Stopping for approval.")
            waiting = (f"Waiting for a human — this would push {imp['oem_customer']}'s "
                       f"order back {imp['delay_days']} days.")
        else:
            reason = f"Exceeds the Rs {APPROVAL_THRESHOLD_INR:,} autonomous limit"
            blocked_line = (f"Rs {chosen['total_cost']:,.0f} exceeds my "
                            f"Rs {APPROVAL_THRESHOLD_INR:,} authority. "
                            f"Stopping for human approval.")
            waiting = (f"Waiting for a human — Rs {chosen['total_cost']:,.0f} "
                       f"is over my spending authority.")

        await conn.execute(
            """insert into approvals (incident_id, action, estimated_cost, reason, brief, status)
               values ($1,$2,$3,$4,$5,'pending')""",
            incident_id, chosen["label"], chosen["total_cost"], reason, narrative)
        await _step(conn, incident_id, blocked_line, status="blocked")
        await emit(conn, incident_id=incident_id, actor="agent",
                   event_type="APPROVAL_REQUIRED", human_summary=waiting,
                   payload={"cost": chosen["total_cost"],
                            "threshold": APPROVAL_THRESHOLD_INR,
                            "kind": chosen.get("kind"), "impact": imp})
        await broadcast_state("approval_required", {"incident_id": incident_id})
        return

    await _step(conn, incident_id,
                f"Rs {chosen['total_cost']:,.0f} is within my Rs {APPROVAL_THRESHOLD_INR:,} "
                f"authority. Executing without approval.")
    await execute(conn, incident_id)


async def execute(conn, incident_id: str) -> None:
    """EXECUTE → VERIFY. Creates the PO, then keeps ownership until stock is real."""
    st = _STATE.get(incident_id, {})
    chosen = (st.get("result") or {}).get("chosen")
    if not chosen:
        return

    await _set_status(conn, incident_id, "executing")

    # A reschedule releases units before anything is bought — the residual we
    # then purchase is smaller precisely because the other run stood down.
    impact = chosen.get("impact")
    if chosen.get("kind") == "reschedule_other" and impact:
        row = await conn.fetchrow(
            """update production_orders
                  set deadline           = deadline + make_interval(days => $2),
                      original_deadline  = coalesce(original_deadline, deadline),
                      rescheduled_at     = now(),
                      rescheduled_reason = $3,
                      allocated_units    = 0
                where id = $1 and allocated_units > 0
            returning deadline, allocated_units""",
            impact["production_order_id"], int(impact["delay_days"]),
            f"Released {impact['units_freed']} units to incident {incident_id}")
        if row is None:
            await _step(conn, incident_id,
                        f"{impact['product_name']} was already rescheduled by someone else — "
                        f"its units are no longer mine to spend. Replanning.",
                        status="warning")
            await _plan_and_validate(conn, incident_id)
            return
        await emit(conn, incident_id=incident_id, actor="agent",
                   event_type="PRODUCTION_RESCHEDULED",
                   human_summary=(
                       f"{impact['product_name']} for {impact['oem_customer']} pushed back "
                       f"{impact['delay_days']} days, releasing {impact['units_freed']} units."),
                   payload={**impact, "now_due": row["deadline"].isoformat()})
        await _step(conn, incident_id,
                    f"Stood {impact['product_name']} down for {impact['delay_days']} days. "
                    f"{impact['units_freed']} units released; "
                    + (f"buying the remaining {impact['residual_units']}."
                       if impact["residual_units"] > 0
                       else "nothing needs to be bought."))

    created = []
    for line in chosen.get("lines", []):
        po_id = f"PO-A{await conn.fetchval('select count(*)+9000 from purchase_orders')}"
        await conn.execute(
            """insert into purchase_orders (id, component_id, supplier_id, warehouse_id,
                   quantity, unit_price, mode, expected_delivery, status,
                   created_by_agent, incident_id)
               values ($1,$2,$3,'Pune-Plant-1',$4,$5,$6::transport_mode,
                       $7, 'open', true, $8)""",
            po_id, st["component_id"], line["supplier_id"], line["quantity"],
            line["unit_price"], line["mode"],
            CLOCK.now().replace(microsecond=0), incident_id)
        created.append(po_id)
        await comms.agent_message_supplier(
            conn, incident_id=incident_id, supplier_id=line["supplier_id"],
            kind="rfq", context={"component_name": st.get("component_name"),
                                 "quantity": line["quantity"], "needed_by": "confirmed order"})

    await _step(conn, incident_id,
                f"Created {len(created)} recovery purchase order(s): {', '.join(created)}.")
    await emit(conn, incident_id=incident_id, actor="agent", event_type="ERP_UPDATED",
               human_summary=f"ERP updated with {len(created)} new purchase order(s).",
               payload={"purchase_orders": created})

    await _set_status(conn, incident_id, "verifying")
    await _step(conn, incident_id,
                "Monitoring. I will not close this until usable stock is confirmed at the plant.")
    await broadcast_state("incident_executing", {"incident_id": incident_id})


async def resume(conn, incident_id: str, *, decision: str,
                 note: str | None = None, exclude: list[str] | None = None) -> None:
    """The interrupt exit. Human decided; agent picks the graph back up."""
    st = _STATE.setdefault(incident_id, {"incident_id": incident_id})

    if decision == "approve":
        await _step(conn, incident_id, f"Human approved the plan. Resuming execution."
                                       + (f" Note: {note}" if note else ""))
        await conn.execute(
            "update recovery_plans set status='approved', decided_at=now() where id=$1",
            st.get("plan_id"))
        await execute(conn, incident_id)
        return

    if decision == "reject":
        await conn.execute(
            "update recovery_plans set status='rejected', decided_at=now() where id=$1",
            st.get("plan_id"))
        await _step(conn, incident_id,
                    f"Human rejected the plan{': ' + note if note else ''}. Replanning.",
                    status="warning")
        await _plan_and_validate(conn, incident_id)
        return

    if decision == "modify":
        for sup in (exclude or []):
            await conn.execute(
                """insert into agent_constraints
                     (incident_id, constraint_type, target, reason, created_by)
                   values ($1,'exclude_supplier',$2,$3,'human')""",
                incident_id, sup, note or "Excluded by operator")
        await conn.execute(
            "update recovery_plans set status='superseded', decided_at=now() where id=$1",
            st.get("plan_id"))
        await _step(conn, incident_id,
                    f"Human added a constraint — never use {', '.join(exclude or [])}. "
                    f"That invalidates the current plan, replanning now.", status="warning")
        await emit(conn, incident_id=incident_id, actor="human",
                   event_type="CONSTRAINT_ADDED",
                   human_summary=f"Operator excluded {', '.join(exclude or [])}. "
                                 f"{note or ''}".strip(),
                   payload={"exclude": exclude, "note": note})
        await _plan_and_validate(conn, incident_id)


async def verify(conn, incident_id: str) -> dict[str, Any]:
    """Executed is not resolved. Close only when USABLE stock covers the need."""
    st = _STATE.get(incident_id, {})
    cid = st.get("component_id") or await conn.fetchval(
        "select component_id from incidents where id=$1", incident_id)

    row = await conn.fetchrow(
        """select i.usable_stock, i.safety_stock, i.daily_usage,
                  (select max(po.units_planned*po.component_per_unit)
                     from production_orders po
                    where po.required_component=$1 and po.is_on_hold=false) as required
             from inventory i where i.component_id=$1""", cid)
    shortfall = int((row["required"] or 0) - row["usable_stock"] + row["safety_stock"])

    if shortfall <= 0:
        await _set_status(conn, incident_id, "resolved")
        await conn.execute("update incidents set closed_at=now() where id=$1", incident_id)
        await _step(conn, incident_id,
                    "Usable stock now covers the production requirement. Incident closed.")
        await emit(conn, incident_id=incident_id, actor="agent", event_type="INCIDENT_RESOLVED",
                   human_summary="Verified at the plant — production is covered. Closing.",
                   payload={"usable": row["usable_stock"]})
        return {"resolved": True, "shortfall": 0}

    await conn.execute(
        "update incidents set reopen_count = reopen_count + 1 where id=$1", incident_id)
    await _set_status(conn, incident_id, "investigating")
    await _step(conn, incident_id,
                f"Recovery did not hold — still {shortfall} units short of usable stock. "
                f"Reopening and replanning.", status="warning")
    await emit(conn, incident_id=incident_id, actor="agent", event_type="INCIDENT_REOPENED",
               human_summary=f"Recovery failed verification: {shortfall} units still short.",
               payload={"shortfall": shortfall})
    await _plan_and_validate(conn, incident_id)
    return {"resolved": False, "shortfall": shortfall}
