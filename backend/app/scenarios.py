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


def list_scenarios() -> list[dict[str, Any]]:
    return [
        {
            "id": s["id"],
            "title": s["title"],
            "tests": s["tests"],
            "event_count": len(s["events"]),
            "span_sim_hours": max((e.get("at_h", 0) for e in s["events"]), default=0),
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
