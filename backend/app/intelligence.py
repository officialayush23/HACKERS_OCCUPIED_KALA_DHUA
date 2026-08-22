"""Decision intelligence — the brief, in the shape a decision is actually made in.

The Decision Explorer answers *what did the solver pick and what did it refuse*.
That is a comparison, and it is the right screen for a procurement analyst. It
is the wrong screen for the person who has to sign.

What that person asks, in this order:

    What do we actually know, and how do we know it?   → EVIDENCE
    So what is true about this situation?              → CONCLUSION
    What is being done about it?                       → ACTION
    Why that and not something else?                   → WHY
    How sure are you, and what would change your mind? → CONFIDENCE

This module builds exactly that, deterministically, out of rows that already
exist. Nothing here is generated prose: every line is assembled from a fact with
a source attached, because a brief whose reasoning was written afterwards is a
rationalisation, and an auditor can tell the difference.

Two rules the evidence table is built on:

**Every row names what it was checked against.** A figure with no corroboration
is marked `single_source` and drags confidence down. That is not pessimism — a
stock number nobody has laid eyes on is genuinely worth less than one a human
counted.

**Confidence is arithmetic, not a mood.** It starts at 1.0 and every unverified
or contradicted piece of evidence subtracts a stated amount. The subtractions
are listed, so somebody who disagrees with the weighting can argue with it.

NO LLM IN THIS FILE.
"""
from __future__ import annotations

import json
from typing import Any

from .core import APPROVAL_THRESHOLD_INR, CLOCK, hours_between
from .solver import solve_for_production_order

# What each verdict costs in confidence. Written down rather than tuned by feel,
# so the number on screen can be reconstructed by hand from the table above it.
PENALTY = {
    "contradicted":  0.30,   # two sources disagree and we know which one lied
    "single_source": 0.10,   # nobody has checked this
    "stale":         0.12,   # true once, hours ago, in a moving world
    "hedged":        0.15,   # a counterparty said something that commits them to nothing
    "unresolved":    0.20,   # the agent asked a human a question and is still waiting
}

BAND = [(0.80, "high"), (0.55, "moderate"), (0.0, "low")]


def _band(score: float) -> str:
    for floor, name in BAND:
        if score >= floor:
            return name
    return "low"


def _ev(source: str, question: str, finding: str, *, checked_against: str,
        verdict: str, weight: str = "", at: Any = None) -> dict[str, Any]:
    return {"source": source, "question": question, "finding": finding,
            "checked_against": checked_against, "verdict": verdict,
            "weight": weight, "at": at.isoformat() if hasattr(at, "isoformat") else at}


async def brief(conn, *, incident_id: str | None = None,
                production_order_id: str | None = None) -> dict[str, Any]:
    """Assemble the brief for one incident, or for the run in the most trouble."""

    # ---------------------------------------------------------- what subject --
    inc = None
    if incident_id:
        inc = await conn.fetchrow(
            """select i.*, coalesce(c.display_name, c.name) as component_name,
                      c.part_number
                 from incidents i left join components c on c.id = i.component_id
                where i.id = $1""", incident_id)
    if inc is None and not production_order_id:
        inc = await conn.fetchrow(
            """select i.*, coalesce(c.display_name, c.name) as component_name,
                      c.part_number
                 from incidents i left join components c on c.id = i.component_id
                where i.status not in ('resolved','failed')
                order by case i.severity::text when 'critical' then 0 when 'high' then 1
                                               when 'medium' then 2 else 3 end,
                         i.opened_at desc limit 1""")
    if inc is not None:
        incident_id = inc["id"]

    component_id = (inc["component_id"] if inc else None)

    if not production_order_id:
        production_order_id = await conn.fetchval(
            """select po.id from production_orders po
                where ($1::text is null or po.required_component = $1)
                  and not po.is_on_hold
                order by case po.priority::text when 'critical' then 0 when 'high' then 1
                                                when 'medium' then 2 else 3 end,
                         po.deadline limit 1""", component_id)

    if not production_order_id:
        return {"available": False,
                "reason": "Nothing is at risk, so there is nothing to brief on."}

    order = await conn.fetchrow(
        """select po.*, pr.name as product_name,
                  coalesce(c.display_name, c.name) as component_name, c.part_number,
                  c.required_certifications, c.is_hazmat
             from production_orders po
             left join products pr on pr.id = po.product_id
             join components c on c.id = po.required_component
            where po.id = $1""", production_order_id)
    if order is None:
        return {"available": False, "reason": f"Unknown production run {production_order_id}"}

    component_id = component_id or order["required_component"]
    result = await solve_for_production_order(conn, production_order_id)
    ctx = result.get("context", {})

    evidence: list[dict[str, Any]] = []
    deductions: list[dict[str, Any]] = []

    def deduct(kind: str, why: str) -> None:
        deductions.append({"kind": kind, "cost": PENALTY[kind], "why": why})

    # ------------------------------------------------------------- evidence --
    #
    # 1. Stock. The number everything else is arithmetic on top of.
    inv = await conn.fetchrow(
        """select i.*, extract(epoch from (now() - i.last_updated))/3600 as age_hours
             from inventory i where i.component_id = $1""", component_id)
    counted = await conn.fetchrow(
        """select ts, human_summary, technical_payload from audit_events
            where event_type = 'PHYSICAL_COUNT_CONFIRMED'
              and technical_payload->>'component_id' = $1
            order by sequence desc limit 1""", component_id)

    if inv is not None:
        erp, usable = int(inv["erp_stock"]), int(inv["usable_stock"])
        gap = erp - usable
        if counted is not None:
            evidence.append(_ev(
                "Warehouse — physical count",
                "How many units are actually fit to go on the line?",
                f"{usable} usable" + (f", {inv['quarantined_stock']} on quality hold"
                                      if inv["quarantined_stock"] else ""),
                checked_against=f"ERP, which says {erp}",
                verdict="contradicted" if gap else "corroborated",
                weight="This is the figure every downstream number uses.",
                at=counted["ts"]))
            if gap:
                deduct("contradicted",
                       f"ERP overstates {order['component_name']} by {gap} units. We are "
                       f"planning on the counted figure, but the ERP is wrong about "
                       f"something and may be wrong about more.")
        else:
            evidence.append(_ev(
                "ERP — inventory record",
                "How many units are actually fit to go on the line?",
                f"{usable} usable against {erp} in the ERP",
                checked_against="nothing — no physical count has come back yet",
                verdict="single_source",
                weight="Unverified. A warehouse task is the way to fix this.",
                at=inv["last_updated"]))
            deduct("single_source",
                   "No human has counted this stock. The whole shortfall rests on a "
                   "figure that has not been laid eyes on.")
            if float(inv["age_hours"] or 0) > 24:
                deduct("stale", f"The inventory row was last updated "
                                f"{float(inv['age_hours']):.0f} hours ago.")

    # 2. Claims about inbound shipments, against the carrier.
    pos = await conn.fetch(
        """select p.id, p.supplier_id, p.quantity, p.status::text as status,
                  p.expected_delivery, coalesce(s.legal_name, s.name) as supplier_name,
                  t.supplier_claim, t.tracking_status, t.updated_at
             from purchase_orders p
             join suppliers s on s.id = p.supplier_id
             left join shipment_tracking t on t.po_id = p.id
            where p.component_id = $1 and p.status in ('open','in_transit','delayed')""",
        component_id)

    for p in pos:
        contradicted = (p["supplier_claim"] in ("dispatched", "in_transit")
                        and p["tracking_status"] in ("label_created_no_pickup",
                                                     "not_shipped"))
        if p["supplier_claim"] is None and p["tracking_status"] is None:
            continue
        evidence.append(_ev(
            f"{p['supplier_name']} — claim on {p['id']}",
            f"Has {p['quantity']} units actually left their facility?",
            (f"They say “{p['supplier_claim'] or 'nothing'}”. "
             f"The carrier shows “{p['tracking_status'] or 'no scan'}”."),
            checked_against="carrier tracking",
            verdict="contradicted" if contradicted else (
                "corroborated" if p["supplier_claim"] == p["tracking_status"]
                else "single_source"),
            weight=("This shipment is not counted as supply." if contradicted
                    else f"{p['quantity']} units expected "
                         f"{p['expected_delivery'].date()}."),
            at=p["updated_at"]))
        if contradicted:
            deduct("contradicted",
                   f"{p['supplier_name']} said {p['id']} shipped and the carrier says it "
                   f"never moved. Nothing else they tell us about this order is worth "
                   f"much until something scans.")

    # 3. What suppliers said, and how much of it commits them.
    reads = await conn.fetch(
        """select ts, technical_payload from audit_events
            where event_type = 'MESSAGE_INTERPRETED'
              and ($1::text is null or incident_id = $1)
            order by sequence desc limit 6""", incident_id)
    for r in reads:
        pl = r["technical_payload"]
        pl = json.loads(pl) if isinstance(pl, str) else (pl or {})
        who = pl.get("supplier_name") or pl.get("supplier_id") or "a supplier"
        firm = bool(pl.get("firm_commitment"))
        evidence.append(_ev(
            f"{who} — reply",
            "Did they commit to a quantity, a price and a date?",
            pl.get("summary") or "—",
            checked_against="the wording of the message itself",
            verdict="corroborated" if firm else "hedged",
            weight=("Firm — this can be planned against." if firm
                    else "Not a commitment. Treated as information, not supply."),
            at=r["ts"]))
        if not firm and pl.get("quantity_mentioned") is not None:
            deduct("hedged",
                   f"{who} mentions {pl['quantity_mentioned']} units without committing "
                   f"to them. Counting those units would be inventing supply.")

    # 4. Who else already has a claim on the pool.
    if int(ctx.get("claimed_by_others") or 0) > 0:
        holders = await conn.fetch(
            """select o.id, o.oem_customer, o.priority::text as priority,
                      o.allocated_units, pr.name as product_name
                 from production_orders o
                 left join products pr on pr.id = o.product_id
                where o.required_component = $1 and o.id <> $2
                  and not o.is_on_hold and o.allocated_units > 0""",
            component_id, production_order_id)
        detail = "; ".join(
            f"{h['product_name'] or h['id']} for {h['oem_customer']} holds "
            f"{h['allocated_units']}" for h in holders)
        evidence.append(_ev(
            "Production schedule — allocations",
            "Is the stock in the building actually ours to spend?",
            f"{ctx['pool_stock']} in the pool, {ctx['claimed_by_others']} already "
            f"claimed. {detail}",
            checked_against="every open production run on this component",
            verdict="corroborated",
            weight="Only unclaimed stock counts toward this shortfall."))

    # 5. Questions the agent asked and has not had answered.
    unanswered = await conn.fetch(
        """select id, question, detail, confidence from human_input_requests
            where status='open' and ($1::text is null or incident_id = $1)
            order by id desc limit 5""", incident_id)
    for q in unanswered:
        evidence.append(_ev(
            "Agent — open question",
            q["question"],
            q["detail"] or "Waiting on a human.",
            checked_against="nothing — this is what it could not resolve",
            verdict="unresolved",
            weight="The plan below is the best available without this answer."))
        deduct("unresolved", f"Unanswered: {q['question']}")

    # ----------------------------------------------------------- conclusion --
    hours_left = float(result.get("hours_left") or 0)
    shortfall = int(result.get("shortfall") or 0)
    cover_days = (float(ctx.get("usable_stock", 0)) / ctx["daily_usage"]
                  if ctx.get("daily_usage") else None)

    arithmetic = [
        {"label": "Required for this run",
         "value": f"{ctx.get('required_units', 0)} units",
         "note": f"{order['units_planned']} × {order['component_per_unit']} per unit"},
        {"label": "Available to this run",
         "value": f"{ctx.get('usable_stock', 0)} units",
         "note": (f"{ctx.get('pool_stock', 0)} in the building less "
                  f"{ctx.get('claimed_by_others', 0)} claimed by other runs")},
        {"label": "Safety floor",
         "value": f"+ {ctx.get('safety_stock', 0)} units",
         "note": "not consumable without justification"},
        {"label": "Short by", "value": f"{shortfall} units",
         "note": "this is what has to be recovered", "emphasis": True},
    ]

    conclusion = {
        "statement": (
            f"{order['product_name'] or order['id']} for {order['oem_customer']} is "
            f"{shortfall} units of {order['component_name']} short with "
            f"{hours_left / 24:.1f} days to the deadline."
            if shortfall > 0 else
            f"{order['product_name'] or order['id']} is covered — usable stock meets "
            f"the requirement with the safety floor intact."),
        "arithmetic": arithmetic,
        "severity": (inc["severity"] if inc else
                     ("critical" if hours_left < 24 else "high" if shortfall > 0 else "low")),
        "coverage_days": round(cover_days, 1) if cover_days is not None else None,
        "deadline": ctx.get("deadline"),
        "hours_left": round(hours_left, 1),
    }

    # --------------------------------------------------------------- action --
    plan = await conn.fetchrow(
        """select * from recovery_plans where incident_id = $1
            order by id desc limit 1""", incident_id) if incident_id else None
    approval = await conn.fetchrow(
        """select * from approvals where incident_id = $1
            order by id desc limit 1""", incident_id) if incident_id else None
    chosen = result.get("chosen")

    if plan is not None:
        state = plan["status"]
        action = {
            "label": plan["label"],
            "kind": plan["option_kind"],
            "cost": float(plan["total_cost"] or 0),
            "score": float(plan["score"] or 0),
            "status": state,
            "committed": state in ("approved", "executing", "executed"),
            "authority": ("needs a human" if plan["requires_approval"]
                          else "inside the agent's authority"),
            "blocked_reason": (approval["reason"] if approval and
                               approval["status"] == "pending" else None),
            "approval_id": (approval["id"] if approval and
                            approval["status"] == "pending" else None),
        }
    elif chosen:
        action = {
            "label": chosen["label"], "kind": chosen["kind"],
            "cost": float(chosen["total_cost"] or 0), "score": float(chosen["score"] or 0),
            "status": "proposed", "committed": False,
            "authority": ("needs a human" if chosen["requires_approval"]
                          else "inside the agent's authority"),
            "blocked_reason": None, "approval_id": None,
        }
    else:
        action = {
            "label": "No recovery exists", "kind": "none", "cost": 0, "score": 0,
            "status": "none", "committed": False,
            "authority": "needs a human",
            "blocked_reason": "Every candidate was refused on a hard constraint.",
            "approval_id": None,
        }

    # ------------------------------------------------------------------ why --
    why: list[dict[str, str]] = []
    if chosen:
        if chosen.get("kind") == "reschedule_other" and chosen.get("impact"):
            imp = chosen["impact"]
            why.append({
                "claim": "Units before money",
                "because": (f"{imp['product_name']} for {imp['oem_customer']} is "
                            f"{imp['priority']} priority and is holding "
                            f"{imp['units_freed']} of the units we need, with slack in "
                            f"its own deadline. Standing it down costs "
                            f"{imp['delay_days']} days of somebody else's patience "
                            f"instead of Rs {chosen['total_cost']:,.0f} more of "
                            f"emergency freight.")})
            why.append({
                "claim": "It stops for a human anyway",
                "because": ("This is the cheapest option on the board and it still "
                            "halts. The gate is not about the money — delaying another "
                            "customer's order is not a trade an agent makes alone.")})
        elif chosen.get("kind") == "split":
            why.append({
                "claim": "Split rather than single-source",
                "because": (f"No single supplier can cover {shortfall} units inside the "
                            f"deadline. Splitting is what makes the date reachable at "
                            f"all.")})
        for line in (chosen.get("lines") or [])[:2]:
            why.append({
                "claim": f"{line['supplier_name']} at Rs {line['unit_price']:g}/unit",
                "because": (f"{line['quantity']} units by {line['mode']}, arriving in "
                            f"{line['lead_time_hours'] / 24:.1f} days. Reliability "
                            f"{line['reliability']:.2f}, quality {line['quality']:.2f}.")})

    for rej in (result.get("rejections") or [])[:4]:
        why.append({"claim": f"Not {rej['supplier_name']}",
                    "because": rej["human_reason"], "refusal": True})

    if action["authority"] == "needs a human" and action.get("blocked_reason"):
        why.append({"claim": "Why this is on your desk",
                    "because": action["blocked_reason"]})
    elif chosen and not chosen.get("requires_approval"):
        why.append({
            "claim": "Why this did not need you",
            "because": (f"Rs {chosen['total_cost']:,.0f} is inside the "
                        f"Rs {APPROVAL_THRESHOLD_INR:,} limit and nobody else's order "
                        f"moves. The gate is a hard check in code, not a judgement.")})

    # ----------------------------------------------------------- confidence --
    score = 1.0
    for d in deductions:
        score -= d["cost"]
    score = round(max(0.05, min(1.0, score)), 2)

    would_change = []
    kinds = {d["kind"] for d in deductions}
    if "single_source" in kinds:
        would_change.append("A physical count from the floor would settle the stock "
                            "figure and lift this materially.")
    if "contradicted" in kinds:
        would_change.append("A carrier scan on the disputed shipment — in either "
                            "direction — resolves the contradiction.")
    if "hedged" in kinds:
        would_change.append("A supplier committing to a quantity, price and date in "
                            "writing turns information into supply.")
    if "unresolved" in kinds:
        would_change.append("Answering the open question in the queue removes the "
                            "largest single deduction.")
    if not would_change:
        would_change.append("Every figure here has been checked against a second "
                            "source. Only new events move this now.")

    residual: list[str] = []
    if chosen and chosen.get("lines"):
        worst = min(chosen["lines"], key=lambda l: l["reliability"])
        if worst["reliability"] < 0.75:
            residual.append(
                f"{worst['supplier_name']} carries a trust score of "
                f"{worst['reliability']:.2f}. This plan depends on them.")
    if any(e["verdict"] == "contradicted" for e in evidence):
        residual.append("A supplier on this component has been caught contradicting "
                        "carrier data. Their future claims are already discounted.")
    if shortfall > 0 and (not chosen or chosen.get("kind") == "do_nothing"):
        residual.append("There is no recovery that satisfies every hard constraint. "
                        "The line stops unless a constraint is relaxed by a human.")
    if not residual:
        residual.append("Nothing outstanding beyond normal delivery risk.")

    return {
        "available": True,
        "generated_at": CLOCK.now().isoformat(),
        "subject": {
            "incident_id": incident_id,
            "production_order_id": production_order_id,
            "product": order["product_name"] or order["id"],
            "customer": order["oem_customer"],
            "component": order["component_name"],
            "part_number": order["part_number"],
            "priority": order["priority"],
            "title": inc["title"] if inc else None,
        },
        "evidence": evidence,
        "conclusion": conclusion,
        "action": action,
        "why": why,
        "confidence": {
            "score": score,
            "band": _band(score),
            "basis": deductions,
            "would_change_it": would_change,
            "method": ("Starts at 1.00. Every unverified, contradicted or hedged piece "
                       "of evidence subtracts a fixed, published amount. The subtractions "
                       "are listed above so the number can be reconstructed by hand — "
                       "and argued with."),
        },
        "residual_risk": residual,
        "weights": result.get("weights"),
    }
