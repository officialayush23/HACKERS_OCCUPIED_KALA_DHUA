"""Let a tester build the world, not just poke it.

A scenario that can only fire events at the seeded world can test the agent's
*behaviour* but not its *judgement*, because judgement only shows up against
suppliers you chose. Every interesting adversarial test is a world-construction
test:

    "Add a supplier at Rs 90 with no AEC-Q100. Does it buy?"
    "Add one whose minimum order is double what we need. Does it notice?"
    "Give me a lithium component and an air-only lane. Does it refuse?"

None of those can be expressed as an event. They are facts about the world, and
until now the only way to state them was to edit `seed.sql` and restart.

So a custom scenario may carry a `world` block that is applied *before* its first
event fires. It upserts, so it composes with the seed rather than replacing it —
a tester adds one nasty supplier and keeps everything else that makes the
scenario realistic.

NO LLM IN THIS FILE. Everything here is a validated write.
"""
from __future__ import annotations

from typing import Any

MAX_ROWS = 40


class WorldError(ValueError):
    """A validation failure phrased for the person who typed it."""


def _need(obj: dict, key: str, where: str) -> Any:
    if key not in obj or obj[key] in (None, ""):
        raise WorldError(f"{where}: '{key}' is required")
    return obj[key]


def _pos_int(v: Any, key: str, where: str, *, allow_zero: bool = False) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise WorldError(f"{where}: '{key}' must be a whole number, got {v!r}")
    if n < 0 or (n == 0 and not allow_zero):
        raise WorldError(f"{where}: '{key}' must be greater than {'-1' if allow_zero else '0'}")
    return n


def _money(v: Any, key: str, where: str) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise WorldError(f"{where}: '{key}' must be a number, got {v!r}")
    if f < 0:
        raise WorldError(f"{where}: '{key}' cannot be negative")
    return f


def validate(spec: dict[str, Any] | None) -> dict[str, Any]:
    """Check the whole block before touching the database.

    Half-applied worlds are worse than rejected ones: the tester gets a run that
    is neither their scenario nor the seed, and no way to tell which.
    """
    if not spec:
        return {}
    if not isinstance(spec, dict):
        raise WorldError("'world' must be an object")

    out: dict[str, list] = {}

    for section in ("suppliers", "components", "inventory", "production_orders"):
        rows = spec.get(section) or []
        if not isinstance(rows, list):
            raise WorldError(f"'world.{section}' must be a list")
        if len(rows) > MAX_ROWS:
            raise WorldError(f"'world.{section}': at most {MAX_ROWS} rows, got {len(rows)}")
        out[section] = rows

    for i, s in enumerate(out.get("suppliers", [])):
        where = f"world.suppliers[{i}]"
        _need(s, "id", where)
        _need(s, "name", where)
        for j, c in enumerate(s.get("catalog") or []):
            cw = f"{where}.catalog[{j}]"
            _need(c, "component_id", cw)
            _money(_need(c, "unit_price", cw), "unit_price", cw)
            _pos_int(c.get("lead_time_days", 1), "lead_time_days", cw)
            _pos_int(c.get("available_quantity", 1), "available_quantity", cw)
            _pos_int(c.get("min_order_quantity", 1), "min_order_quantity", cw)
        for j, l in enumerate(s.get("lanes") or []):
            lw = f"{where}.lanes[{j}]"
            mode = str(l.get("mode", "SEA")).upper()
            if mode not in ("AIR", "SEA", "ROAD", "RAIL"):
                raise WorldError(f"{lw}: mode must be AIR, SEA, ROAD or RAIL — got {mode!r}")
            _pos_int(l.get("transit_days", 1), "transit_days", lw)
            _money(l.get("freight_cost", 0), "freight_cost", lw)
        if not (s.get("catalog") or []):
            raise WorldError(
                f"{where}: a supplier with no catalog can never be chosen. "
                f"Give it at least one component it sells.")
        if not (s.get("lanes") or []):
            raise WorldError(
                f"{where}: a supplier with no lane cannot ship anything. "
                f"Give it at least one lane (mode, transit_days, freight_cost).")

    for i, c in enumerate(out.get("components", [])):
        where = f"world.components[{i}]"
        _need(c, "id", where)
        _need(c, "name", where)
        _money(c.get("baseline_unit_price", 100), "baseline_unit_price", where)

    for i, r in enumerate(out.get("inventory", [])):
        where = f"world.inventory[{i}]"
        _need(r, "component_id", where)
        _pos_int(r.get("usable_stock", 0), "usable_stock", where, allow_zero=True)

    for i, p in enumerate(out.get("production_orders", [])):
        where = f"world.production_orders[{i}]"
        _need(p, "id", where)
        _need(p, "required_component", where)
        _pos_int(_need(p, "units_planned", where), "units_planned", where)
        pri = str(p.get("priority", "high")).lower()
        if pri not in ("low", "medium", "high", "critical"):
            raise WorldError(f"{where}: priority must be low, medium, high or critical")

    return out


async def apply(conn, spec: dict[str, Any]) -> dict[str, int]:
    """Upsert the world. Runs inside the caller's transaction."""
    spec = validate(spec)
    counts = {"components": 0, "suppliers": 0, "catalog": 0, "lanes": 0,
              "inventory": 0, "production_orders": 0}

    # Components first — suppliers and orders reference them.
    for c in spec.get("components", []):
        await conn.execute(
            """insert into components
                 (id, name, display_name, part_number, is_hazmat,
                  required_certifications, baseline_unit_price, category)
               values ($1,$2,$2,$3,$4,$5,$6,$7)
               on conflict (id) do update set
                 name=excluded.name, display_name=excluded.display_name,
                 is_hazmat=excluded.is_hazmat,
                 required_certifications=excluded.required_certifications,
                 baseline_unit_price=excluded.baseline_unit_price""",
            c["id"], c["name"], c.get("part_number") or c["id"],
            bool(c.get("is_hazmat", False)),
            list(c.get("required_certifications") or []),
            float(c.get("baseline_unit_price", 100)),
            c.get("category"))
        counts["components"] += 1

    for s in spec.get("suppliers", []):
        await conn.execute(
            """insert into suppliers
                 (id, name, legal_name, city, country, certifications,
                  reliability_score, quality_score, lat, lng)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               on conflict (id) do update set
                 name=excluded.name, city=excluded.city, country=excluded.country,
                 certifications=excluded.certifications,
                 reliability_score=excluded.reliability_score,
                 quality_score=excluded.quality_score""",
            s["id"], s["name"], s.get("legal_name") or s["name"],
            s.get("city", "Unknown"), s.get("country", "India"),
            list(s.get("certifications") or []),
            float(s.get("reliability", 0.8)), float(s.get("quality", 0.9)),
            s.get("lat"), s.get("lng"))
        counts["suppliers"] += 1

        for c in s.get("catalog") or []:
            await conn.execute(
                """insert into supplier_catalog
                     (supplier_id, component_id, unit_price, lead_time_days,
                      available_quantity, min_order_quantity)
                   values ($1,$2,$3,$4,$5,$6)
                   on conflict (supplier_id, component_id) do update set
                     unit_price=excluded.unit_price,
                     lead_time_days=excluded.lead_time_days,
                     available_quantity=excluded.available_quantity,
                     min_order_quantity=excluded.min_order_quantity""",
                s["id"], c["component_id"], float(c["unit_price"]),
                int(c.get("lead_time_days", 3)),
                int(c.get("available_quantity", 500)),
                int(c.get("min_order_quantity", 1)))
            counts["catalog"] += 1

        for l in s.get("lanes") or []:
            await conn.execute(
                """insert into supplier_lanes
                     (supplier_id, warehouse_id, mode, transit_days, freight_cost)
                   values ($1,$2,$3::transport_mode,$4,$5)
                   on conflict (supplier_id, warehouse_id, mode) do update set
                     transit_days=excluded.transit_days,
                     freight_cost=excluded.freight_cost""",
                s["id"], l.get("warehouse_id", "Pune-Plant-1"),
                str(l.get("mode", "SEA")).upper(),
                int(l.get("transit_days", 3)), float(l.get("freight_cost", 20000)))
            counts["lanes"] += 1

    for r in spec.get("inventory", []):
        await conn.execute(
            """insert into inventory
                 (component_id, warehouse_id, erp_stock, usable_stock,
                  daily_usage, safety_stock)
               values ($1,$2,$3,$4,$5,$6)
               on conflict (component_id, warehouse_id) do update set
                 erp_stock=excluded.erp_stock, usable_stock=excluded.usable_stock,
                 daily_usage=excluded.daily_usage, safety_stock=excluded.safety_stock,
                 last_updated=now()""",
            r["component_id"], r.get("warehouse_id", "Pune-Plant-1"),
            int(r.get("erp_stock", r.get("usable_stock", 0))),
            int(r.get("usable_stock", 0)),
            int(r.get("daily_usage", 50)), int(r.get("safety_stock", 0)))
        counts["inventory"] += 1

    for p in spec.get("production_orders", []):
        await conn.execute(
            """insert into production_orders
                 (id, product, required_component, units_planned, component_per_unit,
                  deadline, priority, warehouse_id, is_on_hold, oem_customer,
                  allocated_units)
               values ($1,$2,$3,$4,$5, now() + make_interval(days => $6),
                       $7::priority_level,$8,false,$9,$10)
               on conflict (id) do update set
                 required_component=excluded.required_component,
                 units_planned=excluded.units_planned,
                 component_per_unit=excluded.component_per_unit,
                 deadline=excluded.deadline, priority=excluded.priority,
                 oem_customer=excluded.oem_customer,
                 allocated_units=excluded.allocated_units""",
            p["id"], p.get("product", p["id"]), p["required_component"],
            int(p["units_planned"]), int(p.get("component_per_unit", 1)),
            int(p.get("deadline_in_days", 6)),
            str(p.get("priority", "high")).lower(),
            p.get("warehouse_id", "Pune-Plant-1"),
            p.get("oem_customer", "Test Customer"),
            int(p.get("allocated_units", 0)))
        counts["production_orders"] += 1

    return counts


# --------------------------------------------------------------- explain ----


async def explain(conn) -> dict[str, Any]:
    """Describe the world a test will run against — including its traps.

    A tester who cannot see which suppliers are cheap-but-uncertified cannot tell
    whether the agent avoided them on purpose or by luck.
    """
    suppliers = await conn.fetch(
        """select s.id, s.name, s.city, s.country, s.certifications,
                  se.effective_reliability, s.quality_score,
                  sc.component_id, sc.unit_price, sc.lead_time_days,
                  sc.available_quantity, sc.min_order_quantity,
                  c.display_name as component_name, c.required_certifications,
                  c.is_hazmat, c.baseline_unit_price,
                  (select array_agg(distinct l.mode::text) from supplier_lanes l
                    where l.supplier_id = s.id) as modes
             from suppliers s
             join supplier_effective se on se.supplier_id = s.id
             join supplier_catalog sc on sc.supplier_id = s.id
             join components c on c.id = sc.component_id
            order by sc.component_id, sc.unit_price""")

    offers, traps = [], []
    for r in suppliers:
        need = set(r["required_certifications"] or [])
        have = set(r["certifications"] or [])
        modes = [m for m in (r["modes"] or []) if m]
        why: list[str] = []

        if need - have:
            why.append(f"lacks {', '.join(sorted(need - have))}")
        if r["is_hazmat"] and modes and all(m.upper() == "AIR" for m in modes):
            why.append("air-only lane for a hazmat component — prohibited, not expensive")
        cheap = float(r["unit_price"]) < float(r["baseline_unit_price"])

        offer = {
            "supplier_id": r["id"], "supplier_name": r["name"],
            "component_id": r["component_id"], "component_name": r["component_name"],
            "unit_price": float(r["unit_price"]),
            "baseline_unit_price": float(r["baseline_unit_price"]),
            "cheaper_than_baseline": cheap,
            "lead_time_days": r["lead_time_days"],
            "available_quantity": r["available_quantity"],
            "min_order_quantity": r["min_order_quantity"],
            "modes": modes,
            "trust": float(r["effective_reliability"] or 0),
            "blocking_reasons": why,
        }
        offers.append(offer)
        # A trap is only a trap if it is *tempting*: cheap and unusable.
        if why and cheap:
            traps.append({**offer, "why_tempting":
                          f"Rs {offer['unit_price']:g} against a baseline of "
                          f"Rs {offer['baseline_unit_price']:g}"})
        elif r["min_order_quantity"] and r["min_order_quantity"] > 500 and cheap:
            traps.append({**offer, "blocking_reasons":
                          [f"minimum order {r['min_order_quantity']}"],
                          "why_tempting": f"Rs {offer['unit_price']:g}, below baseline"})

    orders = await conn.fetch(
        """select po.id, po.priority::text as priority, po.oem_customer,
                  pr.name as product_name, c.display_name as component_name,
                  po.units_planned * po.component_per_unit as required_units,
                  i.usable_stock, i.erp_stock, i.safety_stock, i.daily_usage,
                  po.units_planned * po.component_per_unit
                    - i.usable_stock + i.safety_stock as shortfall
             from production_orders po
             join inventory i on i.component_id = po.required_component
                             and i.warehouse_id = po.warehouse_id
             join components c on c.id = po.required_component
             left join products pr on pr.id = po.product_id
            order by po.deadline""")

    return {
        "offers": offers,
        "traps": traps,
        "production_orders": [dict(r) for r in orders],
        "note": ("Traps are options that look attractive on price and are refusable on a "
                 "rule. The agent is never told which these are — it has to check."),
    }
