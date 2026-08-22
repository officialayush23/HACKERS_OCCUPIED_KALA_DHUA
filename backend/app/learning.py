"""The supplier learning loop.

Trust is not an opinion the agent forms — it is a ratio the database computes,
and every movement in it is written down with a reason.

Two rules make this honest:

  1. **One definition.** The arithmetic lives in the `supplier_trust()` SQL
     function. Python only records what happened; it never computes a score.
     The moment two places can compute trust, they disagree.

  2. **Symmetry.** Bad news lowers the score and good news raises it. A
     one-way ratchet — the version this replaces — permanently punishes a
     supplier for a single bad week and gives no credit for forty good ones,
     which makes the number useless within a quarter.

NO LLM IN THIS FILE. A model deciding who to trust, over changing state, is a
model that eventually decides the liar is fine.
"""
from __future__ import annotations

from typing import Any

from .core import emit

# What each event does to the counters. The score itself is never set here.
_COUNTERS = {
    "delivered_on_time": "deliveries_on_time = deliveries_on_time + 1, "
                         "promises_kept = promises_kept + 1",
    "delivered_late":    "deliveries_late = deliveries_late + 1",
    "contradiction":     "contradictions_detected = contradictions_detected + 1",
    "quality_failure":   "quality_failures = quality_failures + 1",
    "promise_made":      "promises_made = promises_made + 1",
}

_HEADLINE = {
    "delivered_on_time": "delivered on time",
    "delivered_late":    "delivered late",
    "contradiction":     "claimed a dispatch that never happened",
    "quality_failure":   "shipped parts that failed inspection",
    "promise_made":      "made a new commitment",
}


async def _score(conn, supplier_id: str) -> float:
    return float(await conn.fetchval(
        "select effective_reliability from supplier_effective where supplier_id=$1",
        supplier_id) or 0)


async def record(
    conn,
    supplier_id: str,
    event: str,
    *,
    reason: str,
    incident_id: str | None = None,
    units: int = 0,
    units_rejected: int = 0,
    delay_days: float = 0.0,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Record one thing a supplier did, and let the score follow from it.

    Returns the before/after scores so the caller can narrate the change without
    recomputing anything.
    """
    if event not in _COUNTERS:
        raise ValueError(f"unknown reliability event {event}")

    before = await _score(conn, supplier_id)

    # supplier_memory may have no row yet for a supplier we have never used.
    await conn.execute(
        """insert into supplier_memory (supplier_id) values ($1)
           on conflict (supplier_id) do nothing""", supplier_id)

    # The only interpolation into SQL in this codebase. `event` was whitelisted
    # against _COUNTERS above and raises otherwise, so the fragment is one of a
    # fixed set of literals and no caller string can reach the query text.
    # Everything caller-supplied below is a bound parameter.
    await conn.execute(f"""
        update supplier_memory
           set {_COUNTERS[event]},
               units_delivered = units_delivered + $2,
               units_rejected  = units_rejected + $3,
               avg_delay_days  = case when $4 > 0
                                      then (avg_delay_days + $4) / 2
                                      else avg_delay_days end,
               last_event      = $5,
               last_event_at   = now(),
               updated_at      = now()
         where supplier_id = $1
    """, supplier_id, int(units), int(units_rejected), float(delay_days), event)

    after = await _score(conn, supplier_id)
    delta = round(after - before, 3)

    await conn.execute(
        """insert into reliability_events
             (supplier_id, incident_id, event, before_score, after_score, delta,
              reason, detail)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)""",
        supplier_id, incident_id, event, before, after, delta, reason,
        __import__("json").dumps({**(detail or {}), "units": units,
                                  "units_rejected": units_rejected,
                                  "delay_days": delay_days}))

    name = await conn.fetchval("select name from suppliers where id=$1", supplier_id) \
        or supplier_id
    direction = "up" if delta > 0 else "down" if delta < 0 else "unchanged"
    await emit(conn, incident_id=incident_id, actor="agent",
               event_type="SUPPLIER_LEARNED",
               human_summary=(
                   f"{name} {_HEADLINE[event]}. Trust {direction}"
                   + (f" {abs(delta):.2f} to {after:.2f}." if delta else f" at {after:.2f}.")),
               payload={"supplier_id": supplier_id, "supplier_name": name,
                        "event": event, "before": before, "after": after,
                        "delta": delta, "reason": reason, **(detail or {})})

    return {"supplier_id": supplier_id, "supplier_name": name, "event": event,
            "before": before, "after": after, "delta": delta, "reason": reason}


async def on_goods_received(
    conn, *, po_id: str, quantity_received: int, quantity_rejected: int = 0,
    incident_id: str | None = None,
) -> dict[str, Any] | None:
    """Close the loop on a delivery. This is the only place trust goes *up*.

    On time is measured in hours against the promise the supplier made, not in
    truncated days — a shipment that lands four hours late is late, and one that
    lands four hours early is not.
    """
    po = await conn.fetchrow(
        """select p.id, p.supplier_id, p.expected_delivery, p.quantity,
                  s.name as supplier_name
             from purchase_orders p
             left join suppliers s on s.id = p.supplier_id
            where p.id = $1""", po_id)
    if po is None or not po["supplier_id"]:
        return None

    from .core import CLOCK, hours_between
    late_hours = hours_between(CLOCK.now(), po["expected_delivery"])
    on_time = late_hours <= 0

    if on_time:
        out = await record(
            conn, po["supplier_id"], "delivered_on_time",
            reason=(f"{quantity_received} units on {po_id} arrived "
                    f"{abs(late_hours)/24:.1f} days inside the promised date."),
            incident_id=incident_id, units=quantity_received,
            detail={"po_id": po_id, "hours_early": round(abs(late_hours), 1)})
    else:
        out = await record(
            conn, po["supplier_id"], "delivered_late",
            reason=(f"{quantity_received} units on {po_id} arrived "
                    f"{late_hours/24:.1f} days after the promised date."),
            incident_id=incident_id, units=quantity_received,
            delay_days=round(late_hours / 24.0, 2),
            detail={"po_id": po_id, "hours_late": round(late_hours, 1)})

    if quantity_rejected > 0:
        out = await record(
            conn, po["supplier_id"], "quality_failure",
            reason=(f"{quantity_rejected} of {quantity_received} units on {po_id} "
                    f"failed incoming inspection."),
            incident_id=incident_id, units_rejected=quantity_rejected,
            detail={"po_id": po_id})

    return out


async def history(conn, supplier_id: str, limit: int = 12) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """select event, before_score, after_score, delta, reason, created_at
             from reliability_events
            where supplier_id = $1 order by id desc limit $2""",
        supplier_id, limit)
    return [dict(r) for r in rows]
