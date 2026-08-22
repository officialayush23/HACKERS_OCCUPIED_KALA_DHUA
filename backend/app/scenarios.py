"""Scenario definitions — the adversary.

Built BEFORE the agent, on purpose. You cannot test recovery you cannot
trigger, and the judges will inject hidden disruptions. This is our weapons
range.

`at_h` is simulated hours from injection start. With the default clock
(1 real second == 1 sim hour) a scenario with at_h=48 fires 48 seconds in.
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
        "tests": "Cost vs quality. SUP-29 is cheap and bad.",
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
}


#: Plain language for each injected event, so an operator choosing a scenario can
#: see exactly what will be fed in rather than reading a params blob.
_EVENT_PROSE = {
    "supplier_delay":       lambda p: f"{p.get('po_id')} slips by {p.get('delay_days')} days",
    "inventory_correction": lambda p: (f"physical count of {p.get('component_id')} comes back at "
                                       f"{p.get('usable_stock')} usable"),
    "supplier_claim":       lambda p: f"supplier claims {p.get('po_id')} is '{p.get('claim')}'",
    "tracking_state":       lambda p: (f"carrier tracking for {p.get('po_id')} shows "
                                       f"'{p.get('tracking_status')}'"),
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
            "event_count": len(s["events"]),
            "span_sim_hours": max((e.get("at_h", 0) for e in s["events"]), default=0),
            # What actually gets fed in, in order, in words.
            "feed": [
                {"at_h": e.get("at_h", 0), "type": e["type"],
                 "what": _prose(e), "note": e.get("note")}
                for e in s["events"]
            ],
        }
        for s in SCENARIOS.values()
    ]


#: Every event type the injector understands. The custom-event endpoint in the
#: dashboard accepts exactly these, so you can hand-craft a disruption live.
EVENT_TYPES = [
    "supplier_delay",
    "inventory_correction",
    "supplier_claim",
    "tracking_state",
    "demand_spike",
    "priority_change",
    "deadline_pull_in",
    "quality_failure",
    "expedite_unavailable",
    "hazmat_disruption",
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


def validate_custom(name: str, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reject a bad scenario with a message a human can act on.

    Every failure names the offending event by index and says what was expected.
    A validator that only says "invalid" makes people give up.
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
        if etype not in EVENT_TYPES:
            raise ValueError(
                f"{where}: unknown type '{etype}'. One of: {', '.join(EVENT_TYPES)}")
        params = ev.get("params", {})
        if not isinstance(params, dict):
            raise ValueError(f"{where}: params must be an object")
        try:
            at_h = float(ev.get("at_h", 0))
        except (TypeError, ValueError):
            raise ValueError(f"{where}: at_h must be a number of simulated hours")
        if at_h < 0 or at_h > MAX_CUSTOM_HORIZON_H:
            raise ValueError(
                f"{where}: at_h must be between 0 and {MAX_CUSTOM_HORIZON_H}")
        clean.append({"at_h": at_h, "type": etype, "params": params,
                      "note": (ev.get("note") or None)})

    clean.sort(key=lambda e: e["at_h"])
    return clean


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
        "events": clean,
        "custom": True,
    }
    return sid


def unregister_custom(scenario_id: str) -> None:
    if not scenario_id.startswith("CUSTOM-"):
        raise ValueError("only custom scenarios can be removed")
    SCENARIOS.pop(scenario_id, None)
