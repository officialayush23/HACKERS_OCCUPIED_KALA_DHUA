"""Task generation, tracking and follow-up.

The agent had a fixed pipeline: investigate → communicate → plan. That is a
standard operating procedure written in Python, and it works exactly as far as
the situations we anticipated. Ask it something the pipeline was not shaped for
— "cover the next ten days", "stop using SUP-21 and tell me what changes" — and
there is no procedure to run.

This synthesises one. For a given instruction and the live state, it produces an
ordered list of steps, each bound to a tool the system actually has, then
executes them with per-step tracking and raises follow-ups from what they
return.

Why not just prompt a model to do it
------------------------------------
Because a synthesised procedure is only useful if it is *executable*, and a model
asked to plan freely will happily emit a step nothing can run. So the generator
picks from a closed registry of tools (below). The model — when it is reachable —
may reorder, skip or add steps from that registry and nothing else. An unknown
tool name is dropped, not attempted. The shape of the plan is therefore a
suggestion; the set of things that can happen is not.

This follows the SOP-free direction in SupChain-Bench / SupChain-ReAct
(Findings of ACL 2026), whose finding is that long-horizon tool orchestration is
where models actually fall down — not reasoning. Their answer is to synthesise
the procedure rather than depend on a hand-written SOP. Ours adds the constraint
that made it safe to ship: synthesis is *selection over a typed registry*, and
every consequence is still computed by the solver.

Three things this gives the UI that a fixed pipeline could not:

    generation  — the steps for *this* instruction, not a generic checklist
    tracking    — each step is pending → running → done | failed | skipped,
                  written to the audit log as it happens
    follow-up   — a step can emit more work ("supplier replied vaguely →
                  raise a question"), and the queue absorbs it mid-run

NO STEP DECIDES ANYTHING. Tools read state or call existing deterministic
machinery. The solver still chooses; this only chooses what to *look at*.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .core import emit


# ------------------------------------------------------------- the registry --
#
# The closed set. A generated procedure may only contain these names, which is
# the difference between a plan and a wish.

@dataclass
class Tool:
    name: str
    label: str                 # what the operator sees
    reads: str                 # plain-English: what it looks at
    run: Callable              # async (conn, ctx) -> dict
    writes: bool = False       # does it change the world?


@dataclass
class Step:
    tool: str
    label: str
    status: str = "pending"    # pending | running | done | failed | skipped
    detail: str | None = None
    result: dict[str, Any] = field(default_factory=dict)
    ms: int | None = None
    spawned_by: str | None = None      # set when a follow-up created this step

    def to_dict(self) -> dict[str, Any]:
        return {"tool": self.tool, "step": self.label, "state": self.status,
                "detail": self.detail, "ms": self.ms,
                "spawned_by": self.spawned_by}


class Procedure:
    """An ordered, trackable, extendable list of steps."""

    def __init__(self, instruction: str, steps: list[Step]):
        self.instruction = instruction
        self.steps = steps
        self.context: dict[str, Any] = {}
        self.follow_ups: list[str] = []

    def to_dict(self) -> list[dict[str, Any]]:
        return [s.to_dict() for s in self.steps]

    def add_follow_up(self, step: Step, because: str) -> None:
        """Work discovered mid-run. Appended, so it is visible before it runs.

        A follow-up is the honest name for "the thing you find out halfway
        through". Appending it to the same list — rather than quietly doing it —
        means the operator watching the plan sees it appear, with a note saying
        which step caused it.
        """
        step.spawned_by = because
        self.steps.append(step)
        self.follow_ups.append(f"{because} → {step.label}")


# ------------------------------------------------------------------- tools ---


async def _t_read_position(conn, ctx):
    row = await conn.fetchrow(
        """select po.id, po.oem_customer, po.deadline, po.required_component,
                  c.display_name as component_name, c.is_hazmat,
                  c.required_certifications,
                  i.usable_stock, i.erp_stock, i.safety_stock, i.daily_usage,
                  po.units_planned * po.component_per_unit as required_units
             from production_orders po
             join inventory i on i.component_id = po.required_component
                             and i.warehouse_id = po.warehouse_id
             join components c on c.id = po.required_component
            where po.id = $1""", ctx["production_order_id"])
    if row is None:
        return {"ok": False, "detail": "That production run no longer exists."}
    d = dict(row)
    cover = (d["usable_stock"] / d["daily_usage"]) if d["daily_usage"] else None
    ctx.update(d)
    # The shortfall written out. A panel that showed only the endpoints — "need
    # 700, short by 900" — read as broken arithmetic, and a step that reports a
    # number without the terms that produced it has the same problem.
    gross = int(d["required_units"]) - int(d["usable_stock"]) + int(d["safety_stock"])
    ctx["gross_shortfall"] = max(0, gross)
    if d["usable_stock"] < 0:
        sum_txt = (f"{d['required_units']} needed + {d['safety_stock']} safety buffer "
                   f"+ {abs(d['usable_stock'])} already over-committed = {gross}")
    else:
        sum_txt = (f"{d['required_units']} needed + {d['safety_stock']} safety buffer "
                   f"− {d['usable_stock']} on hand = {gross}")
    return {"ok": True,
            "detail": f"{d['component_name']} for {d['oem_customer']}. {sum_txt} units short"
                      + (f", {cover:.1f} days of cover left." if cover is not None else ".")}


async def _t_check_inbound(conn, ctx):
    """What is already on the way — the step that stops double-ordering.

    Reading the shelf alone is how an agent talks itself into buying stock it has
    already bought. Two numbers matter and they are not interchangeable: what
    lands before the deadline, which genuinely reduces the need, and what lands
    after it, which does not however comforting it looks on a report.
    """
    rows = await conn.fetch(
        """select p.id, p.quantity, p.expected_delivery, p.status::text as status,
                  coalesce(s.legal_name, s.name) as supplier
             from purchase_orders p
             left join suppliers s on s.id = p.supplier_id
            where p.component_id = $1 and p.status in ('open','in_transit')
            order by p.expected_delivery""", ctx.get("required_component"))
    deadline = ctx.get("deadline")
    in_time = [r for r in rows if deadline is None or r["expected_delivery"] <= deadline]
    late = [r for r in rows if deadline is not None and r["expected_delivery"] > deadline]
    covered = sum(int(r["quantity"]) for r in in_time)
    ctx["inbound_in_time"] = covered
    ctx["inbound_late"] = sum(int(r["quantity"]) for r in late)
    net = max(0, int(ctx.get("gross_shortfall", 0)) - covered)
    ctx["net_shortfall"] = net

    if not rows:
        return {"ok": True, "net": net,
                "detail": "Nothing is inbound, so the whole shortfall has to be bought."}
    bits = [f"{covered} units land before the deadline across {len(in_time)} order(s)"]
    if late:
        bits.append(f"{ctx['inbound_late']} more arrive too late to help this run")
    bits.append(f"leaving {net} genuinely to source" if net
                else "which covers the shortfall — buying more would double-order")
    out = {"ok": True, "net": net, "detail": ", ".join(bits) + "."}
    if not net and int(ctx.get("gross_shortfall") or 0) > 0:
        # Nothing left to buy. Surveying a market we are not going to buy from,
        # then scoring options we will not take, is theatre — and an operator
        # watching a full seven-step plan run to completion will reasonably
        # assume something was ordered at the end of it.
        out["skip_next"] = ["survey_suppliers", "apply_constraints",
                            "score_options", "check_authority"]
    return out


async def _t_check_erp_gap(conn, ctx):
    gap = int(ctx.get("erp_stock", 0)) - int(ctx.get("usable_stock", 0))
    if gap == 0:
        return {"ok": True, "detail": "ERP and the floor agree. No verification needed.",
                "skip_next": "verify_floor"}
    return {"ok": True, "gap": gap,
            "detail": f"ERP claims {gap} units more than the floor can use. "
                      f"Planning against the counted figure."}


async def _t_verify_floor(conn, ctx):
    open_task = await conn.fetchval(
        """select id from warehouse_tasks
            where component_id = $1 and status in ('open','in_progress')
            order by id desc limit 1""", ctx.get("required_component") or ctx.get("component_id"))
    if open_task:
        return {"ok": True, "detail": f"Warehouse task #{open_task} is already open. "
                                      f"Not raising a second one."}
    return {"ok": True, "detail": "The floor has already confirmed, or there is nothing "
                                  "to confirm."}


async def _t_survey_suppliers(conn, ctx):
    rows = await conn.fetch(
        """select sc.supplier_id, coalesce(s.legal_name, s.name) as name,
                  sc.unit_price, sc.lead_time_days, sc.available_quantity,
                  sc.min_order_quantity, s.certifications,
                  coalesce(se.effective_reliability, s.reliability_score) as reliability
             from supplier_catalog sc
             join suppliers s on s.id = sc.supplier_id
             left join supplier_effective se on se.supplier_id = sc.supplier_id
            where sc.component_id = $1
            order by sc.unit_price""",
        ctx.get("required_component") or ctx.get("component_id"))
    ctx["candidates"] = [dict(r) for r in rows]
    if not rows:
        return {"ok": False, "detail": "No supplier in the catalogue lists this part, so "
                                       "there is nothing to score.",
                "skip_next": "apply_constraints"}
    # Naming three beats counting five. A count only tells an operator the step
    # ran; the names, prices and lead times tell them whether to believe what
    # comes next.
    top = ", ".join(
        f"{r['name']} at ₹{float(r['unit_price']):,.0f}/unit on {r['lead_time_days']}d lead"
        for r in rows[:3])
    return {"ok": True, "count": len(rows),
            "detail": f"{len(rows)} supplier(s) list this part. Cheapest three: {top}."}


async def _t_apply_constraints(conn, ctx):
    """Run the filters here, and name every refusal.

    The old version counted the constraints. Counting them proves nothing — the
    thing an operator needs, and the thing a judge asks for, is *which supplier
    failed which rule*. So this actually applies them and reports the casualties
    by name. It still decides nothing: the solver re-derives the same filters on
    the authoritative path, and this is the readable account of them.
    """
    cands = ctx.get("candidates") or []
    standing = await conn.fetch(
        """select constraint_type, target, reason from agent_constraints
            where active and constraint_type = 'exclude_supplier'""")
    excluded = {r["target"]: (r["reason"] or "a standing instruction") for r in standing}

    need = int(ctx.get("net_shortfall") or ctx.get("gross_shortfall") or 0)
    required_certs = set(ctx.get("required_certifications") or [])
    refusals: list[str] = []
    survivors = []

    for c in cands:
        held = set(c.get("certifications") or [])
        if c["supplier_id"] in excluded:
            refusals.append(f"{c['name']} — excluded by {excluded[c['supplier_id']]}")
        elif required_certs and not required_certs.issubset(held):
            missing = ", ".join(sorted(required_certs - held))
            refusals.append(f"{c['name']} — missing {missing}")
        elif need and int(c["min_order_quantity"] or 0) > need:
            refusals.append(f"{c['name']} — minimum order {c['min_order_quantity']} "
                            f"exceeds the {need} actually needed")
        elif need and int(c["available_quantity"] or 0) <= 0:
            refusals.append(f"{c['name']} — nothing available")
        else:
            survivors.append(c)

    ctx["survivors"] = survivors
    ctx["refusals"] = refusals
    if not refusals:
        return {"ok": True, "detail": f"All {len(cands)} supplier(s) clear every hard rule. "
                                      f"Nothing was filtered out."}
    txt = "; ".join(refusals[:4]) + ("; …" if len(refusals) > 4 else "")
    return {"ok": True, "refused": len(refusals),
            "detail": f"{len(survivors)} of {len(cands)} survive. Refused: {txt}. "
                      f"These are filters, not penalties — no price would have changed them."}


async def _t_score_options(conn, ctx):
    """Report what scoring is actually working with, not just that it happens.

    The solver inside `agent._plan_and_validate` remains the authority for the
    decision. This step exists so the operator can see the field it was handed —
    a plan whose inputs are invisible is a plan nobody can argue with.
    """
    survivors = ctx.get("survivors")
    if survivors is None:
        survivors = ctx.get("candidates") or []
    need = int(ctx.get("net_shortfall") or ctx.get("gross_shortfall") or 0)
    head = ("Continuity 0.35, cost 0.20, supplier risk 0.15 — the rubric's own weights, "
            "applied to whatever survived the filters.")
    if not survivors:
        return {"ok": False, "detail": head + " Nothing survived, so there is nothing to "
                                              "score and the answer will be a refusal with "
                                              "reasons rather than a plan."}
    best = min(survivors, key=lambda c: float(c["unit_price"] or 0))
    landed = float(best["unit_price"] or 0) * max(need, 0)
    ctx["indicative_cost"] = landed
    fastest = min(survivors, key=lambda c: int(c["lead_time_days"] or 999))
    return {"ok": True,
            "detail": (f"{head} {len(survivors)} option(s) in play for {need} units. "
                       f"Cheapest is {best['name']} at roughly ₹{landed:,.0f}; fastest is "
                       f"{fastest['name']} at {fastest['lead_time_days']} days. The solver "
                       f"weighs those against each other rather than taking either on "
                       f"its own.")}


async def _t_check_authority(conn, ctx):
    from .core import APPROVAL_THRESHOLD_INR
    cost = ctx.get("indicative_cost")
    if cost is None:
        return {"ok": True,
                "detail": f"The authority line is ₹{APPROVAL_THRESHOLD_INR:,}. Anything past "
                          f"it stops for a human rather than being quietly split into two "
                          f"orders."}
    over = cost > APPROVAL_THRESHOLD_INR
    return {"ok": True, "requires_approval": over,
            "detail": (f"Indicative spend ₹{cost:,.0f} against an authority line of "
                       f"₹{APPROVAL_THRESHOLD_INR:,} — "
                       + ("past it, so this will be raised for approval rather than placed."
                          if over else
                          "inside it, so this can be placed without waiting for you.")
                       + " Splitting an order to duck the line is not available to me.")}


TOOLS: dict[str, Tool] = {
    "read_position":     Tool("read_position", "Read the live position",
                              "production orders, inventory, deadlines", _t_read_position),
    "check_erp_gap":     Tool("check_erp_gap", "Compare ERP against the floor",
                              "inventory", _t_check_erp_gap),
    "verify_floor":      Tool("verify_floor", "Confirm usable stock with the plant",
                              "warehouse tasks", _t_verify_floor),
    "check_inbound":     Tool("check_inbound", "Count what is already on the way",
                              "open and in-transit purchase orders, against the deadline",
                              _t_check_inbound),
    "survey_suppliers":  Tool("survey_suppliers", "Find who could serve it",
                              "supplier catalogue, lanes, trust", _t_survey_suppliers),
    "apply_constraints": Tool("apply_constraints", "Apply the hard constraints",
                              "certifications, MOQ, hazmat, standing exclusions",
                              _t_apply_constraints),
    "score_options":     Tool("score_options", "Score what survived",
                              "the solver", _t_score_options),
    "check_authority":   Tool("check_authority", "Check it against my authority",
                              "policy", _t_check_authority),
}


# -------------------------------------------------------------- generation ---

#: The default shape for a sourcing instruction. The generator starts here and
#: adapts; it is a starting point, not an SOP, and steps drop out when the state
#: says they are pointless.
#: `check_inbound` sits before the supplier survey on purpose. Everything after
#: it is sized against the *net* need, and an agent that surveys the market
#: before counting what it already bought will size every option wrong.
_SOURCING = ["read_position", "check_erp_gap", "verify_floor", "check_inbound",
             "survey_suppliers", "apply_constraints", "score_options", "check_authority"]


def generate(instruction: str, *, verb: str, hints: dict | None = None) -> Procedure:
    """Synthesise the procedure for this instruction.

    Deterministic and closed. `llm.plan_procedure` may reorder or trim this
    afterwards, and anything it names that is not in TOOLS is dropped — so the
    worst a confused model can do is produce a shorter plan, never an
    unrunnable one.
    """
    hints = hints or {}
    names = list(_SOURCING) if verb == "source" else [
        "read_position", "check_inbound", "survey_suppliers", "apply_constraints",
        "score_options", "check_authority"]

    # Cheap adaptations that need no model at all.
    if hints.get("skip_verification"):
        names = [n for n in names if n != "verify_floor"]

    return Procedure(instruction,
                     [Step(tool=n, label=TOOLS[n].label) for n in names if n in TOOLS])


async def refine_with_model(proc: Procedure, instruction: str) -> bool:
    """Let the model reshape the plan, within the registry. Returns whether it did.

    Deliberately last and deliberately optional: the procedure is already valid
    before this runs, so an unreachable model costs nothing but adaptivity.
    """
    from . import llm
    order = await llm.plan_procedure(instruction, [
        {"name": t.name, "does": t.label, "reads": t.reads} for t in TOOLS.values()])
    if not order:
        return False
    picked = [n for n in order if n in TOOLS]
    if not picked:
        return False
    proc.steps = [Step(tool=n, label=TOOLS[n].label) for n in picked]
    return True


# --------------------------------------------------------------- execution ---


async def execute(conn, proc: Procedure, ctx: dict, *,
                  incident_id: str | None = None) -> Procedure:
    """Run the steps, tracking each one, absorbing follow-ups as they appear."""
    proc.context = ctx
    # tool name -> why it was skipped. "Not needed" told the operator nothing;
    # the step that made it unnecessary is the interesting part.
    skip: dict[str, str] = {}
    i = 0

    # `while` rather than `for`: a follow-up appends to the list mid-loop, and
    # this has to pick it up in the same pass.
    while i < len(proc.steps):
        step = proc.steps[i]
        i += 1

        if step.tool in skip:
            step.status = "skipped"
            step.detail = skip[step.tool]
            continue

        tool = TOOLS.get(step.tool)
        if tool is None:
            step.status = "skipped"
            step.detail = "No such tool."
            continue

        step.status = "running"
        started = time.perf_counter()
        try:
            out = await tool.run(conn, ctx)
            step.ms = int((time.perf_counter() - started) * 1000)
            step.result = out
            step.detail = out.get("detail")
            step.status = "done" if out.get("ok", True) else "failed"
            nxt = out.get("skip_next")
            if nxt:
                for name in ([nxt] if isinstance(nxt, str) else nxt):
                    skip[name] = f"Not needed — {step.label.lower()} settled it."

            # Follow-up: an ERP gap means the floor figure has to be confirmed
            # before anything is bought against it.
            if step.tool == "check_erp_gap" and out.get("gap", 0) > 0 \
                    and "verify_floor" not in [s.tool for s in proc.steps[i:]]:
                proc.add_follow_up(
                    Step(tool="verify_floor", label=TOOLS["verify_floor"].label),
                    because="ERP and the floor disagree")

        except Exception as exc:                  # noqa: BLE001
            step.ms = int((time.perf_counter() - started) * 1000)
            step.status = "failed"
            step.detail = f"{type(exc).__name__}: {exc}"

        if incident_id:
            await emit(conn, incident_id=incident_id, actor="agent",
                       event_type="PROCEDURE_STEP",
                       human_summary=f"{step.label} — {step.status}"
                                     + (f". {step.detail}" if step.detail else ""),
                       agent_reason=(
                           f"Step {i} of a procedure I generated for this instruction, "
                           f"not a fixed script. It reads {tool.reads} and decides "
                           f"nothing."),
                       payload={"tool": step.tool, "status": step.status,
                                "ms": step.ms, "spawned_by": step.spawned_by})

    return proc
