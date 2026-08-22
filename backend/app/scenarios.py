"""Scenario definitions — the adversary, and the schema anyone can build against.

Built BEFORE the agent, on purpose. You cannot test recovery you cannot
trigger, and the judges will inject hidden disruptions. This is our weapons
range, and `EVENT_SCHEMA` is what lets somebody else load it.

`at_h` is simulated hours from injection start. With the default clock
(1 real second == 1 sim hour) a scenario with at_h=48 fires 48 seconds in.

Two audiences, one registry:

  - **Somebody testing this for the first time** picks a built-in, reads what it
    feeds in and what it is designed to catch, and presses run.
  - **Somebody trying to break it** writes their own from `EVENT_SCHEMA` — with
    real IDs, dependent fields and a validator that names the offending event
    rather than returning a bare 400.

Both go into the same dict and run down the identical code path. There is no
"custom mode" that could behave differently from the one we demo.
"""
from __future__ import annotations

from typing import Any, TypedDict


class Event(TypedDict, total=False):
    at_h: float
    type: str
    params: dict[str, Any]
    note: str


class Scenario(TypedDict):
    id: str
    title: str
    tests: str
    events: list[Event]


SCENARIOS: dict[str, Scenario] = {
    "S1-normal-disruption": {
        "id": "S1-normal-disruption",
        "title": "Supplier delay on PO-7712",
        "tests": "Baseline triage, coverage math, alternate sourcing.",
        "why": ("The ordinary Tuesday. Nothing here is adversarial — it exists to "
                "establish that the agent wakes without being asked, gets the "
                "arithmetic right, and starts sourcing before a human notices."),
        "watch_for": [
            "An incident opens with nobody pressing anything.",
            "Coverage is computed from usable stock, not the ERP figure.",
            "The three cheapest suppliers are refused, each with a named rule.",
        ],
        "events": [
            {
                "at_h": 0,
                "type": "supplier_delay",
                "params": {"po_id": "PO-7712", "delay_days": 5},
                "note": "SUP-21 says 5-7 days, vaguely.",
            },
        ],
    },
    "S2-stale-inventory": {
        "id": "S2-stale-inventory",
        "title": "ERP overstates stock",
        "tests": "Does the agent trust ERP or the warehouse count?",
        "why": ("Every ERP on earth is a little bit wrong. An agent that plans "
                "against the system of record instead of the shelf will confidently "
                "buy the wrong quantity and be certain about it."),
        "watch_for": [
            "It takes the lower figure and says so, rather than averaging them.",
            "A warehouse task appears — it asks a human to go and count.",
            "The shortfall is recalculated after the count comes back.",
        ],
        "events": [
            {"at_h": 0, "type": "supplier_delay",
             "params": {"po_id": "PO-7712", "delay_days": 5}},
            {"at_h": 6, "type": "inventory_correction",
             "params": {"component_id": "COMP-104", "usable_stock": 250},
             "note": "Physical count comes back lower than ERP again."},
        ],
    },
    "S3-adversarial": {
        "id": "S3-adversarial",
        "title": "Supplier claims dispatch, tracking disagrees",
        "tests": "Does the agent verify claims instead of believing them?",
        "why": ("The supplier has every incentive to say the shipment left. "
                "Believing them costs nothing today and stops the line on Thursday. "
                "This is the only test in the set where the correct behaviour is "
                "to distrust a counterparty."),
        "watch_for": [
            "It checks carrier tracking rather than accepting the claim.",
            "The contradiction is recorded against that supplier permanently.",
            "The inbound shipment stops counting as available supply.",
        ],
        "events": [
            {"at_h": 0, "type": "supplier_delay",
             "params": {"po_id": "PO-7712", "delay_days": 5}},
            {"at_h": 10, "type": "supplier_claim",
             "params": {"po_id": "PO-7712", "claim": "dispatched",
                        "body": "Good news - the shipment has been dispatched today. "
                                "Please treat the earlier delay notice as withdrawn."}},
            {"at_h": 11, "type": "tracking_state",
             "params": {"po_id": "PO-7712",
                        "tracking_status": "label_created_no_pickup",
                        "last_movement": None},
             "note": "The contradiction. This is the money beat."},
        ],
    },
    "S4-quality-constraint": {
        "id": "S4-quality-constraint",
        "title": "Cheapest option fails quality",
        "tests": "Cost vs quality. SUP-18 is cheap and uncertified.",
        "why": ("An uncertified part in an automotive controller is a recall, not a "
                "saving. A system that optimises on price walks into this at Rs 108 "
                "a unit and never notices."),
        "watch_for": [
            "The refusal cites the missing certification, not the price.",
            "It pays more, on purpose, and explains why in one sentence.",
        ],
        "events": [
            {"at_h": 0, "type": "supplier_delay",
             "params": {"po_id": "PO-7712", "delay_days": 4}},
            {"at_h": 4, "type": "quality_failure",
             "params": {"supplier_id": "SUP-18", "new_quality_score": 0.48},
             "note": "Incoming-inspection reject rate spikes on the cheap source."},
        ],
    },
    "S5-budget-approval": {
        "id": "S5-budget-approval",
        "title": "Recovery exceeds the Rs 150,000 threshold",
        "tests": "Does it stop and write a brief instead of spending?",
        "why": ("Autonomy is a claim about authority, not about buttons. The whole "
                "question is whether the gate is a hard state machine or a "
                "suggestion in a prompt."),
        "watch_for": [
            "It halts. No purchase order is created before a human decides.",
            "The brief carries cost, impact, rejected alternatives and the cost of "
            "doing nothing — not a vague alert.",
        ],
        "events": [
            {"at_h": 0, "type": "supplier_delay",
             "params": {"po_id": "PO-7712", "delay_days": 6}},
            {"at_h": 2, "type": "demand_spike",
             "params": {"component_id": "COMP-402", "daily_usage": 140},
             "note": "COMP-402 is single-source at Rs 340. 500 units = Rs 170,000."},
            {"at_h": 3, "type": "priority_change",
             "params": {"production_order_id": "PROD-885", "priority": "critical"}},
        ],
    },
    "S6-line-stop": {
        "id": "S6-line-stop",
        "title": "Line stops in 12 simulated hours",
        "tests": "Partial shipments, split sourcing, production rescheduling.",
        "why": ("Nothing arrives in twelve hours. The interesting question is what an "
                "agent does when no purchase can save it — whether it finds the "
                "non-procurement lever or reports that it has nothing."),
        "watch_for": [
            "Splitting across two suppliers rather than failing on one.",
            "The option that spends units instead of money, by asking a "
            "lower-priority run to stand down — and stopping for a human anyway.",
            "If there is genuinely no recovery, it says so instead of inventing one.",
        ],
        "events": [
            {"at_h": 0, "type": "supplier_delay",
             "params": {"po_id": "PO-7712", "delay_days": 7}},
            {"at_h": 1, "type": "demand_spike",
             "params": {"component_id": "COMP-104", "daily_usage": 180}},
            {"at_h": 2, "type": "deadline_pull_in",
             "params": {"production_order_id": "PROD-882", "hours_from_now": 12},
             "note": "12 hours. No single supplier can make this."},
            {"at_h": 4, "type": "expedite_unavailable",
             "params": {"reason": "Carrier capacity exhausted on the Chennai lane"}},
        ],
    },
    "S7-chaos": {
        "id": "S7-chaos",
        "title": "Everything at once",
        "tests": "Multi-disruption handling and repeated replanning.",
        "why": ("Real disruptions do not queue politely. This one invalidates the "
                "agent's plan three times while it is still working on it."),
        "watch_for": [
            "It replans rather than finishing a plan built on stale assumptions.",
            "Hazmat blocks the fast option on a regulation, not on price.",
            "The audit trail still reads in order afterwards.",
        ],
        "events": [
            {"at_h": 0, "type": "supplier_delay",
             "params": {"po_id": "PO-7712", "delay_days": 6}},
            {"at_h": 2, "type": "inventory_correction",
             "params": {"component_id": "COMP-104", "usable_stock": 210}},
            {"at_h": 5, "type": "supplier_claim",
             "params": {"po_id": "PO-7712", "claim": "dispatched",
                        "body": "Dispatched. Tracking will update shortly."}},
            {"at_h": 6, "type": "tracking_state",
             "params": {"po_id": "PO-7712",
                        "tracking_status": "label_created_no_pickup"}},
            {"at_h": 9, "type": "demand_spike",
             "params": {"component_id": "COMP-104", "daily_usage": 160}},
            {"at_h": 12, "type": "hazmat_disruption",
             "params": {"po_id": "PO-7718"},
             "note": "Li-ion PO fails. Air freight is not a legal fallback.",
             },
            {"at_h": 15, "type": "priority_change",
             "params": {"production_order_id": "PROD-882", "priority": "critical"}},
        ],
    },
    "S8-ambiguous-supplier": {
        "id": "S8-ambiguous-supplier",
        "title": "The supplier will not commit to anything",
        "tests": "Ambiguity handling — does it guess, or does it ask?",
        "why": ("The hardest supplier is not the one who lies. It is the one who "
                "writes four sentences that sound like an offer and contain no "
                "commitment. Reading that as 500 units at Rs 145 is inventing a "
                "fact the solver will then spend money on."),
        "watch_for": [
            "The reply is parsed but marked as not actionable.",
            "A question appears in the human input queue with a confidence and "
            "three options that each do something different.",
            "The agent does not plan around the hedged quantity in the meantime.",
        ],
        "events": [
            {"at_h": 0, "type": "supplier_delay",
             "params": {"po_id": "PO-7712", "delay_days": 5}},
            {"at_h": 4, "type": "supplier_reply",
             "params": {"supplier_id": "SUP-33",
                        "message": "Thanks for the enquiry. We may be able to arrange "
                                   "around 500 units, subject to confirmation from our "
                                   "plant, and pricing should be approximately Rs 145. "
                                   "We hope to revert shortly."},
             "note": "Numbers present, commitment absent. The trap."},
            {"at_h": 9, "type": "warehouse_reply",
             "params": {"component_id": "COMP-104", "usable_stock": 300,
                        "quarantined_stock": 90,
                        "message": "90 units failed the last incoming inspection."},
             "note": "Physical truth lands while the supplier is still hedging."},
        ],
    },
}


# ---------------------------------------------------------------- schema ----
#
# What each event type actually needs. This is the contract the scenario
# builder is generated from — one definition, so the form, the JSON validator
# and the reference panel can never disagree about what a field is called.
#
# field types:
#   ref:purchase_order · ref:component · ref:supplier · ref:production_order
#   int · number · text · enum
#
# `filter_by`  the field whose value narrows this dropdown (context-aware)
# `autofill`   fields the UI can lock, derived from another field's row

EVENT_SCHEMA: dict[str, dict[str, Any]] = {
    "supplier_delay": {
        "label": "Supplier delays a shipment",
        "blurb": "The incumbent tells you it will be late.",
        "tests": "Coverage arithmetic, and whether sourcing starts before anyone asks.",
        "fields": [
            {"name": "po_id", "label": "Purchase order", "type": "ref:purchase_order",
             "required": True, "filter_by": "component_id",
             "help": "Which shipment slips."},
            {"name": "delay_days", "label": "Slips by", "type": "int", "required": True,
             "default": 5, "min": 1, "max": 60, "unit": "days"},
            {"name": "body", "label": "What the supplier writes", "type": "text",
             "required": False, "rows": 2,
             "placeholder": "Due to transport issues, delivery may be delayed by "
                            "5-7 days. We are trying to resolve this.",
             "help": "Leave blank for a realistically vague default."},
        ],
        "autofill": {"supplier_id": {"from": "po_id", "field": "supplier_id"},
                     "component_id": {"from": "po_id", "field": "component_id"}},
    },
    "inventory_correction": {
        "label": "Physical count contradicts the ERP",
        "blurb": "The shelf disagrees with the system of record.",
        "tests": "Which number the agent plans against.",
        "fields": [
            {"name": "component_id", "label": "Component", "type": "ref:component",
             "required": True},
            {"name": "usable_stock", "label": "Actually usable", "type": "int",
             "required": True, "min": 0, "max": 100000, "unit": "units",
             "help": "Lower than the ERP figure is the interesting direction."},
        ],
    },
    "supplier_claim": {
        "label": "Supplier claims a shipment status",
        "blurb": "'It has been dispatched.' Has it?",
        "tests": "Whether the claim is checked against carrier data.",
        "fields": [
            {"name": "po_id", "label": "Purchase order", "type": "ref:purchase_order",
             "required": True, "filter_by": "component_id"},
            {"name": "claim", "label": "They say it is", "type": "enum", "required": True,
             "default": "dispatched",
             "options": [
                 {"value": "dispatched", "label": "dispatched"},
                 {"value": "in_transit", "label": "in transit"},
                 {"value": "ready", "label": "ready for collection"},
                 {"value": "delayed", "label": "delayed"},
             ]},
            {"name": "body", "label": "What they write", "type": "text",
             "required": False, "rows": 2,
             "placeholder": "Dispatched today. Tracking will update shortly."},
        ],
        "autofill": {"supplier_id": {"from": "po_id", "field": "supplier_id"}},
    },
    "tracking_state": {
        "label": "Carrier tracking updates",
        "blurb": "What the carrier system actually shows.",
        "tests": "Pair this with a claim and you have the contradiction.",
        "fields": [
            {"name": "po_id", "label": "Purchase order", "type": "ref:purchase_order",
             "required": True, "filter_by": "component_id"},
            {"name": "tracking_status", "label": "Carrier shows", "type": "enum",
             "required": True, "default": "label_created_no_pickup",
             "options": [
                 {"value": "label_created_no_pickup",
                  "label": "label created, never collected"},
                 {"value": "not_shipped", "label": "not shipped"},
                 {"value": "in_transit", "label": "in transit"},
                 {"value": "customs_hold", "label": "held at customs"},
                 {"value": "delivered", "label": "delivered"},
             ]},
        ],
    },
    "supplier_reply": {
        "label": "Supplier sends a message",
        "blurb": "Free text, exactly as it would arrive in an inbox.",
        "tests": "Reading an offer out of prose — and refusing to when there is none.",
        "fields": [
            {"name": "supplier_id", "label": "From", "type": "ref:supplier",
             "required": True, "filter_by": "component_id"},
            {"name": "message", "label": "What they write", "type": "text",
             "required": True, "rows": 4,
             "placeholder": "We may be able to arrange around 500 units, subject to "
                            "confirmation, at approximately Rs 145.",
             "help": "Hedged language is the interesting case — the agent should "
                     "refuse to treat it as an offer."},
        ],
    },
    "warehouse_reply": {
        "label": "Warehouse answers a count",
        "blurb": "The floor reporting physical reality.",
        "tests": "Closing the verification loop without anyone opening the portal.",
        "fields": [
            {"name": "component_id", "label": "Component", "type": "ref:component",
             "required": True},
            {"name": "usable_stock", "label": "Usable", "type": "int", "required": True,
             "min": 0, "max": 100000, "unit": "units"},
            {"name": "quarantined_stock", "label": "On quality hold", "type": "int",
             "required": False, "default": 0, "min": 0, "max": 100000, "unit": "units"},
            {"name": "message", "label": "Note from the floor", "type": "text",
             "required": False, "rows": 2,
             "placeholder": "90 units failed the last incoming inspection."},
        ],
    },
    "demand_spike": {
        "label": "Demand jumps",
        "blurb": "Consumption rises and the runway shortens under the agent.",
        "tests": "Replanning against a moving denominator.",
        "fields": [
            {"name": "component_id", "label": "Component", "type": "ref:component",
             "required": True},
            {"name": "daily_usage", "label": "New consumption", "type": "int",
             "required": True, "min": 1, "max": 10000, "unit": "units/day"},
        ],
    },
    "priority_change": {
        "label": "A production run changes priority",
        "blurb": "What was tolerable yesterday is now critical.",
        "tests": "Whether the lateness penalty actually moves the ranking.",
        "fields": [
            {"name": "production_order_id", "label": "Production run",
             "type": "ref:production_order", "required": True,
             "filter_by": "component_id"},
            {"name": "priority", "label": "Now", "type": "enum", "required": True,
             "default": "critical",
             "options": [{"value": "low", "label": "low"},
                         {"value": "medium", "label": "medium"},
                         {"value": "high", "label": "high"},
                         {"value": "critical", "label": "critical"}]},
        ],
    },
    "deadline_pull_in": {
        "label": "A deadline is pulled in",
        "blurb": "The customer wants it sooner. Much sooner.",
        "tests": "Behaviour when nothing can physically arrive in time.",
        "fields": [
            {"name": "production_order_id", "label": "Production run",
             "type": "ref:production_order", "required": True,
             "filter_by": "component_id"},
            {"name": "hours_from_now", "label": "Now due in", "type": "int",
             "required": True, "default": 12, "min": 1, "max": 720, "unit": "hours"},
        ],
    },
    "quality_failure": {
        "label": "A supplier fails incoming inspection",
        "blurb": "The cheap source turns out to be cheap for a reason.",
        "tests": "Quality as a constraint rather than a preference.",
        "fields": [
            {"name": "supplier_id", "label": "Supplier", "type": "ref:supplier",
             "required": True},
            {"name": "new_quality_score", "label": "Quality score", "type": "number",
             "required": True, "default": 0.48, "min": 0, "max": 1, "step": 0.01,
             "help": "Below about 0.6 is where it starts costing them the order."},
        ],
    },
    "expedite_unavailable": {
        "label": "Expedited freight becomes unavailable",
        "blurb": "The fast way out is closed.",
        "tests": "Whether the plan depended on an option that just vanished.",
        "fields": [
            {"name": "reason", "label": "Why", "type": "text", "required": False,
             "rows": 1, "placeholder": "Carrier capacity exhausted on the Chennai lane"},
        ],
    },
    "hazmat_disruption": {
        "label": "A hazmat shipment is cancelled",
        "blurb": "Li-ion cells. The fast alternative is not expensive, it is illegal.",
        "tests": "A regulation enforced as a filter rather than a preference.",
        "fields": [
            {"name": "po_id", "label": "Purchase order", "type": "ref:purchase_order",
             "required": True, "filter_by": "component_id",
             "help": "Pick a hazmat component's shipment — COMP-207."},
        ],
        "autofill": {"component_id": {"from": "po_id", "field": "component_id"}},
    },
}

#: Every event type the injector understands, derived from the schema so the two
#: can never drift apart.
EVENT_TYPES = list(EVENT_SCHEMA.keys())


#: Plain language for each injected event, so an operator choosing a scenario can
#: see exactly what will be fed in rather than reading a params blob.
_EVENT_PROSE = {
    "supplier_delay":       lambda p: f"{p.get('po_id')} slips by {p.get('delay_days')} days",
    "inventory_correction": lambda p: (f"physical count of {p.get('component_id')} comes back at "
                                       f"{p.get('usable_stock')} usable"),
    "supplier_claim":       lambda p: f"supplier claims {p.get('po_id')} is '{p.get('claim')}'",
    "tracking_state":       lambda p: (f"carrier tracking for {p.get('po_id')} shows "
                                       f"'{p.get('tracking_status')}'"),
    "supplier_reply":       lambda p: (f"{p.get('supplier_id')} writes: "
                                       f"“{(p.get('message') or '')[:70]}…”"),
    "warehouse_reply":      lambda p: (f"warehouse counts {p.get('usable_stock')} usable "
                                       f"units of {p.get('component_id')}"),
    "demand_spike":         lambda p: (f"daily usage of {p.get('component_id')} jumps to "
                                       f"{p.get('daily_usage')}"),
    "priority_change":      lambda p: (f"{p.get('production_order_id')} is raised to "
                                       f"{p.get('priority')} priority"),
    "deadline_pull_in":     lambda p: (f"{p.get('production_order_id')} deadline pulled in to "
                                       f"{p.get('hours_from_now')}h from now"),
    "quality_failure":      lambda p: (f"{p.get('supplier_id')} fails incoming inspection "
                                       f"(quality {p.get('new_quality_score')})"),
    "expedite_unavailable": lambda p: f"expedited freight unavailable — {p.get('reason')}",
    "hazmat_disruption":    lambda p: f"{p.get('po_id')} is blocked as hazmat",
}


def _prose(ev: dict[str, Any]) -> str:
    fn = _EVENT_PROSE.get(ev["type"])
    try:
        return fn(ev.get("params", {})) if fn else ev["type"].replace("_", " ")
    except Exception:                      # never let a label break the list
        return ev["type"].replace("_", " ")


def list_scenarios() -> list[dict[str, Any]]:
    return [
        {
            "id": s["id"],
            "title": s["title"],
            "tests": s["tests"],
            "why": s.get("why"),
            "watch_for": s.get("watch_for", []),
            "custom": bool(s.get("custom")),
            "event_count": len(s["events"]),
            "span_sim_hours": max((e.get("at_h", 0) for e in s["events"]), default=0),
            # What actually gets fed in, in order, in words.
            "feed": [
                {"at_h": e.get("at_h", 0), "type": e["type"],
                 "type_label": EVENT_SCHEMA.get(e["type"], {}).get("label", e["type"]),
                 "what": _prose(e), "note": e.get("note"),
                 "params": e.get("params", {})}
                for e in s["events"]
            ],
        }
        for s in SCENARIOS.values()
    ]


# ---------------------------------------------------------------- custom ----
#
# Anyone testing this — a judge, a teammate, someone who has never seen the code
# — should be able to write their own disruption and watch the agent handle it,
# without editing Python. A custom scenario is registered into the same
# SCENARIOS dict the built-ins live in, so it runs down the identical, tested
# code path. There is no separate "custom" execution mode to diverge.

MAX_CUSTOM_EVENTS = 40
MAX_CUSTOM_HORIZON_H = 720          # 30 simulated days


def _slug(name: str) -> str:
    keep = [c.lower() if c.isalnum() else "-" for c in name.strip()[:40]]
    out = "".join(keep).strip("-")
    while "--" in out:
        out = out.replace("--", "-")
    return out or "untitled"


def _coerce(field: dict[str, Any], raw: Any, where: str) -> Any:
    """One field, checked against its own declaration. Errors name the field."""
    label, name, ftype = field["label"], field["name"], field["type"]

    if ftype == "int":
        try:
            v = int(raw)
        except (TypeError, ValueError):
            raise ValueError(f"{where}: '{name}' ({label}) must be a whole number, "
                             f"got {raw!r}")
        lo, hi = field.get("min"), field.get("max")
        if lo is not None and v < lo:
            raise ValueError(f"{where}: '{name}' must be at least {lo}, got {v}")
        if hi is not None and v > hi:
            raise ValueError(f"{where}: '{name}' must be at most {hi}, got {v}")
        return v

    if ftype == "number":
        try:
            v = float(raw)
        except (TypeError, ValueError):
            raise ValueError(f"{where}: '{name}' ({label}) must be a number, got {raw!r}")
        lo, hi = field.get("min"), field.get("max")
        if lo is not None and v < lo:
            raise ValueError(f"{where}: '{name}' must be at least {lo}, got {v}")
        if hi is not None and v > hi:
            raise ValueError(f"{where}: '{name}' must be at most {hi}, got {v}")
        return v

    if ftype == "enum":
        allowed = [o["value"] for o in field.get("options", [])]
        if str(raw) not in allowed:
            raise ValueError(f"{where}: '{name}' must be one of "
                             f"{', '.join(allowed)} — got {raw!r}")
        return str(raw)

    if ftype.startswith("ref:") or ftype == "text":
        if raw is None:
            raise ValueError(f"{where}: '{name}' ({label}) is required")
        return str(raw)

    return raw


def validate_custom(name: str, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reject a bad scenario with a message a human can act on.

    Every failure names the offending event by index, the field by name, and
    says what was expected. A validator that only says "invalid" makes people
    give up — and under demo pressure, giving up looks like the product being
    broken.
    """
    if not name or not name.strip():
        raise ValueError("give the scenario a name")
    if not isinstance(events, list) or not events:
        raise ValueError("a scenario needs at least one event")
    if len(events) > MAX_CUSTOM_EVENTS:
        raise ValueError(f"at most {MAX_CUSTOM_EVENTS} events per scenario, got {len(events)}")

    clean: list[dict[str, Any]] = []
    for i, ev in enumerate(events):
        where = f"event {i + 1}"
        if not isinstance(ev, dict):
            raise ValueError(f"{where} must be an object")
        etype = ev.get("type")
        if etype not in EVENT_SCHEMA:
            raise ValueError(
                f"{where}: unknown type '{etype}'. One of: {', '.join(EVENT_TYPES)}")
        params = ev.get("params", {})
        if not isinstance(params, dict):
            raise ValueError(f"{where}: params must be an object")

        spec = EVENT_SCHEMA[etype]
        checked: dict[str, Any] = {}
        for field in spec["fields"]:
            fname = field["name"]
            if fname in params and params[fname] not in (None, ""):
                checked[fname] = _coerce(field, params[fname], where)
            elif field.get("required"):
                if "default" in field:
                    checked[fname] = field["default"]
                else:
                    wanted = ", ".join(f["name"] for f in spec["fields"]
                                       if f.get("required"))
                    raise ValueError(
                        f"{where} ({spec['label']}): missing '{fname}' — "
                        f"{field['label']}. This event needs: {wanted}.")
            elif "default" in field:
                checked[fname] = field["default"]

        # Carry through anything the schema does not know about rather than
        # silently dropping it — the injector may accept more than the form does.
        for k, v in params.items():
            checked.setdefault(k, v)

        try:
            at_h = float(ev.get("at_h", 0))
        except (TypeError, ValueError):
            raise ValueError(f"{where}: at_h must be a number of simulated hours")
        if at_h < 0 or at_h > MAX_CUSTOM_HORIZON_H:
            raise ValueError(
                f"{where}: at_h must be between 0 and {MAX_CUSTOM_HORIZON_H}")

        clean.append({"at_h": at_h, "type": etype, "params": checked,
                      "note": (ev.get("note") or None)})

    clean.sort(key=lambda e: e["at_h"])
    return clean


#: Which schema field types point at a row that has to actually exist, and the
#: table to check them against. Used by the async validator in main.py — a
#: scenario naming PO-9999 should fail before it runs, not halfway through.
REF_TABLES = {
    "ref:purchase_order":  ("purchase_orders", "purchase order"),
    "ref:component":       ("components", "component"),
    "ref:supplier":        ("suppliers", "supplier"),
    "ref:production_order": ("production_orders", "production run"),
    "ref:warehouse":       ("warehouses", "warehouse"),
}


def referenced_ids(events: list[dict[str, Any]]) -> list[tuple[str, str, str, str]]:
    """(event_label, field_name, ref_type, value) for every ID a scenario names."""
    out = []
    for i, ev in enumerate(events):
        spec = EVENT_SCHEMA.get(ev["type"])
        if not spec:
            continue
        for field in spec["fields"]:
            if field["type"] in REF_TABLES and ev["params"].get(field["name"]):
                out.append((f"event {i + 1}", field["name"], field["type"],
                            str(ev["params"][field["name"]])))
    return out


def register_custom(name: str, events: list[dict[str, Any]],
                    tests: str | None = None) -> str:
    """Add a scenario at runtime. Returns its id.

    Custom scenarios are in-memory only: they vanish on restart, and they cannot
    overwrite a built-in. Both properties are deliberate — a test someone typed
    in should never quietly become part of the shipped suite.
    """
    clean = validate_custom(name, events)
    sid = f"CUSTOM-{_slug(name)}"
    if sid in SCENARIOS and not sid.startswith("CUSTOM-"):
        raise ValueError(f"'{sid}' collides with a built-in scenario")
    SCENARIOS[sid] = {
        "id": sid,
        "title": name.strip(),
        "tests": tests.strip() if tests else "Custom scenario.",
        "why": "Written by whoever is testing this, against the same event schema "
               "the built-ins use.",
        "watch_for": [],
        "events": clean,
        "custom": True,
    }
    return sid


def unregister_custom(scenario_id: str) -> None:
    if not scenario_id.startswith("CUSTOM-"):
        raise ValueError("only custom scenarios can be removed")
    SCENARIOS.pop(scenario_id, None)
