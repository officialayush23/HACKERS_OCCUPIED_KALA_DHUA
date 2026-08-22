"""Reactive controller — the thing that makes this an agent instead of a tool.

No human clicks Solve. An event lands, a deterministic risk detector asks
"does this threaten production?", and if it does the incident opens itself
and the agent wakes.

    Event → risk detector → threatens production? → open incident → wake agent

The detector is deliberately deterministic. Deciding whether a line stops is
arithmetic, not judgement.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Any

from .core import CLOCK, hours_between

#: Hours of production cover below which we treat it as an emergency.
CRITICAL_HOURS = 24.0
HIGH_HOURS = 96.0
MEDIUM_HOURS = 240.0

PRIORITY_ESCALATION = {"critical": 2, "high": 1, "medium": 0, "low": -1}
LADDER = ["low", "medium", "high", "critical"]


@dataclass
class ThreatenedOrder:
    production_order_id: str
    product_name: str | None
    oem_customer: str | None
    priority: str
    shortfall: int
    hours_to_deadline: float
    coverage_hours: float


@dataclass
class RiskVerdict:
    threatens_production: bool
    severity: str
    headline: str
    component_id: str | None
    component_name: str | None
    coverage_days: float | None
    threatened: list[ThreatenedOrder] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["threatened"] = [asdict(t) for t in self.threatened]
        return d


IMPACT_SQL = """
select po.id                              as production_order_id,
       pr.name                            as product_name,
       po.oem_customer,
       po.priority::text                  as priority,
       po.deadline,
       po.units_planned * po.component_per_unit as required_units,
       i.usable_stock, i.erp_stock, i.daily_usage, i.safety_stock,
       c.display_name                     as component_name
  from production_orders po
  join inventory  i  on i.component_id = po.required_component
                    and i.warehouse_id = po.warehouse_id
  join components c  on c.id = po.required_component
  left join products pr on pr.id = po.product_id
 where po.required_component = $1
   and po.is_on_hold = false
"""


async def assess(conn, component_id: str, *, trigger: str) -> RiskVerdict:
    """Does this component's situation threaten production? Pure arithmetic."""
    rows = await conn.fetch(IMPACT_SQL, component_id)
    if not rows:
        return RiskVerdict(False, "low", "No production depends on this component.",
                           component_id, None, None)

    now = CLOCK.now()
    threatened: list[ThreatenedOrder] = []
    reasons: list[str] = []
    worst_coverage = None
    component_name = rows[0]["component_name"] or component_id

    for r in rows:
        usable = int(r["usable_stock"])
        daily = int(r["daily_usage"]) or 1
        coverage_hours = (usable / daily) * 24.0
        worst_coverage = coverage_hours if worst_coverage is None else min(worst_coverage, coverage_hours)

        shortfall = int(r["required_units"] - usable + r["safety_stock"])
        hours_left = hours_between(r["deadline"], now)

        # Incoming stock that genuinely lands before the deadline
        incoming = int(await conn.fetchval(
            """select coalesce(sum(quantity),0) from purchase_orders
                where component_id=$1 and status in ('open','in_transit')
                  and expected_delivery <= $2""", component_id, r["deadline"]) or 0)

        if shortfall - incoming > 0:
            threatened.append(ThreatenedOrder(
                production_order_id=r["production_order_id"],
                product_name=r["product_name"], oem_customer=r["oem_customer"],
                priority=r["priority"], shortfall=shortfall - incoming,
                hours_to_deadline=round(hours_left, 1),
                coverage_hours=round(coverage_hours, 1)))

        if int(r["erp_stock"]) != usable:
            reasons.append(
                f"ERP reports {r['erp_stock']} units but only {usable} are usable.")

    if not threatened:
        return RiskVerdict(False, "low",
                           f"{component_name} is covered. No production order is short.",
                           component_id, component_name,
                           round((worst_coverage or 0) / 24, 1), [], reasons)

    # Severity from the tightest coverage, escalated by order priority
    tightest = min(t.coverage_hours for t in threatened)
    base = ("critical" if tightest <= CRITICAL_HOURS
            else "high" if tightest <= HIGH_HOURS
            else "medium" if tightest <= MEDIUM_HOURS
            else "low")
    bump = max(PRIORITY_ESCALATION.get(t.priority, 0) for t in threatened)
    severity = LADDER[min(len(LADDER) - 1, max(0, LADDER.index(base) + max(0, bump - 1)))]

    worst = min(threatened, key=lambda t: t.coverage_hours)
    headline = (
        f"{worst.product_name or 'Production'}"
        + (f" for {worst.oem_customer}" if worst.oem_customer else "") + " "
        f"needs {worst.shortfall} more {component_name} — "
        f"the line stops in {worst.coverage_hours / 24:.1f} days."
    )
    reasons.insert(0, f"Trigger: {trigger}.")

    return RiskVerdict(True, severity, headline, component_id, component_name,
                       round(tightest / 24, 1), threatened, reasons)
