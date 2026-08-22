"""Self-scorer — implements the judges' own formula.

Nobody else builds this. Running it after every scenario means we tune against
the real rubric instead of guessing, and showing judges our own scorecard is
disarming.

    0.35*continuity + 0.20*cost + 0.15*risk + 0.10*tool_eff + 0.10*recovery
  + 0.10*audit

The `total` column is GENERATED in Postgres, so the weights cannot drift
between the scorer and the database.
"""
from __future__ import annotations

import json

from typing import Any

from .core import CLOCK, emit, hours_between

#: Expected tool calls for a competent run. Above par is waste, far below is
#: usually a sign the agent skipped evidence it needed.
PAR_TOOL_CALLS = 8

TOOL_EVENTS = ("TOOL_CALLED", "OPTION_REJECTED", "OPTION_SELECTED")


async def score_run(conn, run_id: int) -> dict[str, Any]:
    run = await conn.fetchrow("select * from scenario_runs where id=$1", run_id)
    if run is None:
        raise ValueError(f"unknown run {run_id}")

    events = await conn.fetch(
        "select event_type, actor, technical_payload from audit_events "
        "where scenario_run_id=$1 order by sequence", run_id)
    types = [e["event_type"] for e in events]

    def payload(e) -> dict:
        """asyncpg hands back jsonb as a string unless a codec is registered."""
        v = e["technical_payload"]
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return {}
        return v or {}

    # ---- continuity (0.35): did any production order miss its deadline? -----
    prods = await conn.fetch(
        """select po.id, po.priority::text as priority, po.deadline,
                  po.units_planned * po.component_per_unit as required,
                  i.usable_stock, i.safety_stock
             from production_orders po
             join inventory i on i.component_id = po.required_component
                             and i.warehouse_id = po.warehouse_id
            where po.is_on_hold = false""")
    now = CLOCK.now()
    weights = {"critical": 3.0, "high": 2.0, "medium": 1.0, "low": 0.5}
    total_w = covered_w = 0.0
    at_risk = []
    for p in prods:
        w = weights.get(p["priority"], 1.0)
        total_w += w
        shortfall = int(p["required"] - p["usable_stock"] + p["safety_stock"])
        if shortfall <= 0:
            covered_w += w
            continue
        incoming = await conn.fetchval(
            """select coalesce(sum(quantity),0) from purchase_orders
                where component_id = (select required_component from production_orders where id=$1)
                  and status in ('open','in_transit')
                  and expected_delivery <= $2""", p["id"], p["deadline"])
        if int(incoming or 0) >= shortfall:
            covered_w += w
        else:
            at_risk.append({"production_order_id": p["id"], "priority": p["priority"],
                            "shortfall": shortfall, "incoming": int(incoming or 0),
                            "hours_left": round(hours_between(p["deadline"], now), 1)})
    continuity = covered_w / total_w if total_w else 0.0

    # ---- cost (0.20): agent spend against the emergency budget --------------
    spent = float(await conn.fetchval(
        "select coalesce(sum(total_value),0) from purchase_orders where created_by_agent") or 0)
    budget = float(await conn.fetchval(
        "select (value)::text::numeric from system_config where key='emergency_budget_inr'") or 1)
    cost = max(0.0, 1.0 - (spent / budget)) if budget else 0.0

    # ---- supplier risk (0.15): did it catch the liar and the bad cert? ------
    caught = types.count("CLAIM_CONTRADICTED")
    planted = await conn.fetchval(
        """select count(*) from shipment_tracking
            where supplier_claim in ('dispatched','in_transit')
              and tracking_status in ('label_created_no_pickup','not_shipped')""")
    detection = 1.0 if not planted else min(1.0, caught / planted)
    cert_rejections = sum(
        1 for e in events
        if e["event_type"] == "OPTION_REJECTED"
        and payload(e).get("constraint") == "REQUIRED_CERTIFICATION")
    risk = 0.6 * detection + 0.4 * (1.0 if cert_rejections else 0.0)

    # ---- tool efficiency (0.10) --------------------------------------------
    calls = sum(1 for t in types if t in TOOL_EVENTS)
    tool_eff = 1.0 if calls == 0 else min(1.0, PAR_TOOL_CALLS / max(calls, 1))

    # ---- recovery (0.10): did it replan after a mid-flight injection? -------
    late_injection = any(
        t in ("CLAIM_CONTRADICTED", "INVENTORY_DISCREPANCY", "DEMAND_SPIKE",
              "DEADLINE_PULLED_IN", "HAZMAT_SUPPLY_FAILURE") for t in types)
    replanned = types.count("OPTION_SELECTED") > 1 or "REPLAN_TRIGGERED" in types
    recovery = 1.0 if (not late_injection or replanned) else 0.0

    # ---- audit (0.10): decisions carrying recorded reasons ------------------
    decisions = types.count("OPTION_SELECTED")
    reasons = types.count("OPTION_REJECTED")
    audit = 0.0 if decisions == 0 else min(1.0, reasons / max(decisions * 2, 1))

    row = await conn.fetchrow(
        """insert into run_scores (run_id, continuity, cost, risk, tool_eff, recovery, audit)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (run_id) do update
             set continuity=$2, cost=$3, risk=$4, tool_eff=$5, recovery=$6,
                 audit=$7, computed_at=now()
           returning *""",
        run_id, round(continuity, 3), round(cost, 3), round(risk, 3),
        round(tool_eff, 3), round(recovery, 3), round(audit, 3))

    result = {k: (float(v) if isinstance(v, (int, float)) or hasattr(v, "quantize") else v)
              for k, v in dict(row).items()}
    result["detail"] = {
        "at_risk_production": at_risk,
        "agent_spend_inr": spent,
        "budget_inr": budget,
        "contradictions_planted": int(planted or 0),
        "contradictions_caught": caught,
        "certification_rejections": cert_rejections,
        "tool_calls": calls,
        "par_tool_calls": PAR_TOOL_CALLS,
        "replanned": replanned,
    }

    await emit(conn, actor="scorer", event_type="RUN_SCORED",
               scenario_run_id=run_id,
               human_summary=(f"Run {run_id} scored {float(row['total']):.3f} "
                              f"(continuity {continuity:.2f}, cost {cost:.2f}, "
                              f"risk {risk:.2f})."),
               payload=result["detail"])
    return result
