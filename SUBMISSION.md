# DisruptionOps — Final Submission

## 1. Team Details

**Team name:** kala dhua

---

## 2. Problem Statement in Short

Manufacturing supply chains break constantly — a supplier ships late, an ERP system reports
stock that is not physically on the shelf, a shipment is claimed as dispatched when it never
moved. Today a human notices these one at a time, usually too late, and reacts under pressure.

The problem statement asks for an **autonomous agent that detects inbound supply disruptions,
works out whether production is actually threatened, and recovers** — sourcing alternatives,
communicating with suppliers, and escalating to a human when the decision is too consequential
to make alone. It is evaluated on the quality of the decisions it makes: production continuity,
cost, and supplier risk.

---

## 3. Understanding of the Problem Statement

The hard part is not detecting the disruption. It is **deciding correctly under constraints,
and knowing where the agent's authority ends.**

Three things follow from reading the PS closely:

**The scoring is arithmetic, not language.** 70% of the marks are decision quality —
continuity 35%, cost 20%, supplier risk 15%. These are computable from live state. An answer
that *sounds* right and costs ₹40,000 more scores worse than a blunt one that is correct.

**The hidden tests are constraint traps.** A cheap supplier without the required automotive
certification. A cheaper one whose minimum order is double what we need. A fast one that only
ships by air, for a component that is lithium and cannot legally fly. An agent that optimises
on price walks into every one of them.

**"Autonomous" is a claim about authority, not about buttons.** An agent that acts on a stock
figure nobody verified, or commits ₹200,000 without asking, is not autonomous — it is
unsupervised. The interesting engineering is in where it stops.

We are therefore solving **inbound procurement disruption recovery**, end to end, with the
authority boundary as a first-class feature.

---

## 4. Idea Summary

**DisruptionOps is a reactive control agent for a manufacturing plant's inbound supply.**

Its core design decision is a division of labour:

> **The LLM investigates, interprets and explains. Deterministic Python decides.**

The language model reads supplier emails, spots that a claim contradicts carrier tracking, and
writes explanations a plant manager can read. It never selects a supplier or approves a spend.
Every constraint check and every choice is ordinary code — so the agent *cannot* violate a
hard constraint, because the constraint is a filter rather than an instruction.

The agent is **reactive, not invoked**. An event arrives, a deterministic risk detector asks
"does this threaten production?", and if it does the agent wakes itself. Nobody presses Solve.

What makes it useful rather than clever: it **closes its loops**. It asks the warehouse for a
physical count and waits for the answer before acting. It messages suppliers and interprets
what comes back. It only closes an incident when *usable* stock actually covers the
requirement. And it learns — what a supplier promised versus what they did feeds back into a
trust score that changes future decisions.

---

## 5. Proposed Solution

### How it works

```
event → deterministic risk detector → threatens production?
                                            │ yes
      MONITOR → DETECT → TRIAGE → INVESTIGATE → COMMUNICATE
                                            ↓
                        PLAN → VALIDATE → [over authority?] → EXECUTE → VERIFY
                                              │ yes
                                          human decides
```

**Main features**

- **Reactive detection.** A risk detector computes coverage in hours — never truncated days —
  and opens an incident only when a production line is genuinely threatened.
- **Deterministic solver.** Enumerates every recovery option including split-sourcing and doing
  nothing, applies hard constraints, and scores survivors on the rubric's own weights.
  Every refusal is recorded with its reason.
- **Verification over trust.** Supplier claims are checked against carrier tracking. ERP stock
  is checked against a human physical count.
- **Authority gate.** Spending above the threshold, or delaying another customer's order at
  all, stops for a human — who can approve, reject, or **modify**, and a modification becomes a
  permanent constraint.
- **Production ↔ procurement.** The agent can ask whether a lower-priority run can stand down,
  freeing units instead of spending money.
- **Supplier learning.** Delivering on time is the only thing that raises trust; contradictions
  and quality failures lower it. Every movement is recorded with its reason.

**User flow.** A plant manager sees one screen answering: what needs me, what is happening,
what is the agent doing. A warehouse operator gets a separate, deliberately simple screen —
what to go and count, and what their answer will change.

**Stack.** React 19 · Vite · Tailwind · shadcn/ui · TanStack Query · WebSocket ·
FastAPI · asyncpg · Postgres (Supabase) · Gemini for interpretation only.

**Assumptions.** A simulated sandbox, as the PS requires — no live supplier, ERP or email
accounts. Supplier behaviour uses scripted personas, one of which lies. A simulated clock runs
one hour of plant time per real second.

---

## 6. MVP Description

**The MVP is complete and running.**

**Core features included**

- Autonomous detection and recovery, with zero human clicks between disruption and plan
- Deterministic solver with hard constraints and recorded refusals
- Warehouse verification loop, supplier communication loop, delivery loop, learning loop
- Approval workflow with approve / reject / modify
- Decision Explorer with a "what if this supplier fails" re-solve
- Decision Log — every discrepancy as a case, in Business / Agent / Technical views
- Live network view, schematic and real geography
- Seven built-in test scenarios, plus **custom scenarios anyone can write** in the UI or over
  the API — they run down the identical code path
- Self-scoring against the published rubric

**What a user can do:** run a disruption, watch the agent decide without being asked, see which
suppliers were refused and why, knock one out and watch the plan re-form, approve what crosses
its authority, and confirm a physical count that changes the agent's next move.

**What we will demonstrate:** the contradiction catch — a supplier claims a shipment left, the
carrier says it never moved, the agent believes the carrier. Then the refusals: the two cheapest
suppliers are ₹108 and ₹120, we pay ₹145, and the screen names the rule that stopped each.

**Not in the first version:** live ERP or email integrations, multi-plant networks, demand
forecasting, and authentication — the API is currently open, documented in `SECURITY.md`.

**Why this proves the solution:** the decisions are reproducible. The same input always produces
the same choice, and every refusal is on the record.

---

## 7. Impact and Feasibility

**Impact.** A stopped automotive line costs lakhs per hour. The value is not that a machine buys
parts faster — it is that the disruption is caught in minutes rather than at the morning
meeting, and that a system which cannot be talked into an uncertified part is doing the
checking. The audit trail makes the decision defensible afterwards, which is what actually gets
an agent adopted in a regulated supply chain.

**Practicality.** The architecture maps onto how procurement already works: a purchase order, a
goods receipt, a physical count, an approval threshold. A plant changes no process — it
connects existing data.

**Feasibility.** Already built and demonstrable. It runs with no LLM at all: every model call
has a deterministic fallback, so no decision depends on a network request succeeding.

**Risks and how we handle them**

| Risk | Handling |
|---|---|
| LLM unavailable or slow | Every call has a deterministic fallback; the UI shows which mode is live |
| Model produces an unsafe choice | It cannot — the model never decides. Constraints are filters in code |
| Prompt injection in a supplier email | The interpreted result cannot trigger a purchase; only code can |
| Conference wifi fails | Schematic network view needs no tiles; map falls back automatically |
| Agent over-reaches | Spending and customer-impact gates are deterministic, not prompted |
| No authentication yet | Documented honestly; localhost-only for the demo, roles are the next step |

The largest remaining gap is authentication and role separation — a warehouse operator should
not be able to call the endpoint that delays a customer's order. That is well understood, not
architecturally hard, and deliberately not claimed as done.
