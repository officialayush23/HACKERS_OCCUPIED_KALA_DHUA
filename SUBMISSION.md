# DisruptionOps — Final Submission

## 1. Team Details

**Team name:** kala dhua

---

## 2. Problem Statement in Short

Manufacturing supply chains break constantly — a supplier ships late, an ERP reports stock that
is not on the shelf, a shipment is claimed as dispatched when it never moved. A human notices
these one at a time, usually too late, and reacts under pressure.

The problem statement asks for an **autonomous agent that detects inbound supply disruptions,
works out whether production is actually threatened, and recovers** — sourcing alternatives,
communicating with suppliers, and escalating when a decision is too consequential to make
alone. It is graded on decision quality: production continuity, cost, and supplier risk.

---

## 3. Understanding of the Problem Statement

The hard part is not detecting the disruption. It is **deciding correctly under constraints,
and knowing where the agent's authority ends.** Three things follow from reading the PS closely:

**The scoring is arithmetic, not language.** 70% of the marks are decision quality —
continuity 35%, cost 20%, supplier risk 15%, all computable from live state. An answer that
*sounds* right and costs ₹40,000 more scores worse than a blunt one that is correct.

**The hidden tests are constraint traps.** A cheap supplier without the required automotive
certification. A cheaper one whose minimum order is double what we need. A fast one that only
ships by air, for a component that is lithium and cannot legally fly. An agent that optimises
on price walks into every one of them.

**"Autonomous" is a claim about authority, not about buttons.** An agent that acts on a stock
figure nobody verified, or commits ₹200,000 without asking, is unsupervised rather than
autonomous — the interesting engineering is in where it stops. We are therefore solving
**inbound procurement disruption recovery**, end to end, with the authority boundary as a
first-class feature.

---

## 4. Idea Summary

**DisruptionOps is a reactive control agent for a manufacturing plant's inbound supply.** Its
core design decision is a division of labour:

> **The LLM investigates, interprets and explains. Deterministic Python decides.**

The language model reads supplier emails, spots that a claim contradicts carrier tracking, and
writes explanations a plant manager can read. It never selects a supplier or approves a spend —
so the agent *cannot* violate a hard constraint, because the constraint is a filter in code
rather than an instruction in a prompt.

It is **reactive, not invoked** — an event arrives, a risk detector asks whether production is
threatened, and the agent wakes itself — and it **takes instructions** in plain language through
that same loop. What makes it useful rather than clever is that it **closes its loops**: it waits
for a physical count before acting on a stock figure, interprets what suppliers write back,
closes an incident only when *usable* stock covers the requirement, and feeds
promised-versus-actual into a trust score that changes future decisions.

---

## 5. Proposed Solution

### How it works

```
event (or a human instruction) → deterministic risk detector → threatens production?
   MONITOR → DETECT → TRIAGE → INVESTIGATE → COMMUNICATE → PLAN → VALIDATE
        → [over authority? → a human decides] → EXECUTE → VERIFY
```

**Main features**

- **Reactive detection.** Coverage computed in hours — never truncated days — opening an
  incident only when a production line is genuinely threatened.
- **Deterministic solver.** Enumerates every recovery option including split-sourcing and doing
  nothing, applies hard constraints, scores survivors on the rubric's own weights, and records
  every refusal with its reason.
- **Verification over trust.** Supplier claims are checked against carrier tracking; ERP stock
  against a human physical count.
- **Authority gate.** Spending above the threshold, or delaying another customer's order at
  all, stops for a human — who can approve, reject, or **modify**, and a modification becomes a
  permanent constraint.
- **Production ↔ procurement, and learning.** It can ask whether a lower-priority run stands
  down, freeing units instead of money; and delivering on time is the only thing that raises a
  supplier's trust score.

**User flow.** A plant manager sees one screen: what needs me, what is happening, what the
agent is doing. A warehouse operator gets a separate, deliberately simple screen — what to
count, and what their answer will change.

**Stack.** React 19 · Vite · Tailwind · shadcn/ui · TanStack Query · WebSocket ·
FastAPI · asyncpg · Postgres (Supabase) · Gemini for interpretation only.

**Assumptions.** A simulated sandbox, as the PS requires — no live supplier, ERP or email
accounts. Supplier behaviour uses scripted personas, one of which lies. A simulated clock runs
one hour of plant time per real second.

### Instructions in language — task generation, tracking, follow-up

An instruction typed by an operator enters the **same** agent loop an alert does
(`POST /api/agent/command` → `backend/app/command.py`). Two entry points, one intelligence
layer: a command gets no solver, no constraint check and no authority rule of its own, because
two systems eventually disagree about what is allowed. There is deliberately no second "chatbot
agent" beside the real one.

**Task generation.** `backend/app/procedure.py` synthesises an ordered, executable procedure for
*this* instruction rather than running a fixed pipeline. Crucially, generation is *selection
over a closed typed registry of tools*: a model may reorder or trim, and anything it names that
is not in the registry is dropped. The worst a confused model can produce is a shorter plan,
never an unrunnable one.

**Tracking and follow-up.** Every step moves pending → running → done | failed | skipped, timed
in milliseconds and written to `audit_events` as `PROCEDURE_STEP` as it happens. A step can also
append more work mid-run — an ERP-versus-floor gap appends a verification with the plant —
emitted as `FOLLOW_UP_RAISED` and added to the same visible plan rather than done quietly.

**One contract.** Every command returns `status` (completed | needs_approval | blocked |
needs_clarification) alongside `plan`, `blockers`, `alternatives`, `actions_taken` and
`human_action_required`. A refusal always names the rule that stopped it and offers what the
agent *can* do instead — never a bare "cannot".

**Where the idea came from.** SupChain-Bench / SupChain-ReAct (Findings of ACL 2026,
https://aclanthology.org/2026.findings-acl.371/) find that long-horizon *tool orchestration*,
not reasoning, is where models fall down, and answer it with SOP-free procedure synthesis. We
took that — synthesise the procedure instead of hardcoding an SOP — and added constraints of our
own: synthesis is restricted to a typed registry, and every consequence is still computed by the
deterministic solver. We implemented the idea; we did not reproduce their benchmark.

---

## 6. MVP Description

**The MVP is complete and running.**

**Core features included**

- Autonomous detection and recovery, zero human clicks between disruption and plan; command
  mode, taking instructions through the same solver and authority gate
- Deterministic solver with hard constraints and recorded refusals; approve / reject / modify
- Warehouse verification, supplier communication, delivery and learning loops, all closed
- Decision Explorer with a "what if this supplier fails" re-solve, a decision log in Business /
  Agent / Technical views, a live network view, and self-scoring against the published rubric
- **Three actors, three screens, no shortcuts between them** — operations at `/`, the plant
  floor at `/warehouse/<id>`, and a supplier answering in their own words at `/supplier/<id>`.
  While a supplier's page is open the scripted persona stands down and the agent genuinely waits
  for a person. Nothing is piped between tabs: every message goes through the database and the
  agent, which is what makes the loop testable rather than asserted
- Eight built-in scenarios, plus **custom scenarios anyone can write** in the UI or over the
  API — they run down the identical code path

**What a user can do:** run a disruption, watch the agent decide without being asked, tell it
what to do in plain language, see which suppliers were refused and why, knock one out and watch
the plan re-form, approve what crosses its authority, confirm a physical count that changes its
next move, and — in a second window — answer the agent *as the supplier* and watch the plan move
in the first. **What we will demonstrate:** the contradiction catch, told by a
person rather than a script — a human at the supplier screen claims a shipment left, the carrier
record says it never moved, the agent believes the carrier — then the
refusals: the two cheapest suppliers are ₹108 and ₹120, we pay ₹145, and the screen names the
rule that stopped each. The decisions are reproducible; every refusal is on the record.

**Not in the first version:** live ERP or email integrations, multi-plant networks, demand
forecasting, and authentication — the API is open, documented in `SECURITY.md`.

---

## 7. Impact and Feasibility

**Impact.** A stopped automotive line costs lakhs per hour. The value is not that a machine buys
parts faster — it is that the disruption is caught in minutes rather than at the morning
meeting, and that a system which cannot be talked into an uncertified part is doing the
checking. The audit trail is what makes it adoptable in a regulated supply chain.

**Practicality and feasibility.** The architecture maps onto how procurement already works: a
purchase order, a goods receipt, a physical count, an approval threshold — a plant changes no
process, it connects existing data. It is already built, and runs with no LLM at all: every
model call has a deterministic fallback, so no decision depends on a network request.

**Risks and how we handle them**

| Risk | Handling |
|---|---|
| LLM unavailable or slow | Every call has a deterministic fallback; the UI shows which mode is live |
| Model produces an unsafe choice | It cannot — the model never decides. Constraints are filters in code |
| Prompt injection in a supplier email | The interpreted result cannot trigger a purchase; only code can |
| A generated procedure names a step we cannot run | It is dropped — generation only selects from a closed typed tool registry |
| Agent over-reaches | Spending and customer-impact gates are deterministic, not prompted |

The largest remaining gap is authentication and role separation — a warehouse operator should
not be able to call the endpoint that delays a customer's order. Well understood, not
architecturally hard, and deliberately not claimed as done.
