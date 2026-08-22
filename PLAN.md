# Supply Chain Disruption Control Agent — Build Plan

**Team:** kala dhua · Hackers Occupied Pune 2026
**Target:** Layer 3 (Disruption Control Agent) via deterministic solver core
**Assumed budget:** ~40 hours, 3 people
**Status:** v2 — ARCHITECTURE LOCKED. Domain locked. Build starts at Phase 0.

---

## 0. The one idea this plan is built on

70% of the judging rubric is **decision quality measured as numbers**:

| Category | Weight |
|---|---:|
| Production Continuity | 35% |
| Cost Control | 20% |
| Supplier Risk Handling | 15% |
| Tool Efficiency | 10% |
| Recovery / Replanning | 10% |
| Audit Trail | 10% |

Every hidden test in §7 is a **constraint trap**: uncertified cheap supplier, MOQ blocks the obvious buy, high-reliability supplier lacks quantity, cost crosses the approval threshold, supplier claims dispatch but tracking says label-only.

**An LLM asked to pick a supplier under those constraints will silently violate one of them during a live demo.** Not because it's weak — because it's doing arithmetic in prose over changing state.

So: **the decision is made by deterministic Python. The LLM does what only it can do.**

| Seat | Who | Rubric coverage |
|---|---|---|
| Detective — parse vague emails, spot contradictions | **LLM** | Supplier Risk (15%) |
| Investigator — decide which tools to call | **LLM** | Tool Efficiency (10%) |
| Solver — generate + rank recovery options | **Python** | Continuity (35%) + Cost (20%) |
| Validator — hard constraint enforcement | **Python** | Constraint compliance |
| Narrator — audit trail, approval briefs | **LLM** | Audit (10%) |

Side benefit: with a deterministic core, swapping Gemini → Grok → Bedrock is a config change, not a re-validation. **Build and test entirely on Gemini. Do not touch Bedrock.**

---

## 0.5 Domain — what world are we simulating

### The discrepancy you must know about

The two problem files describe **different problems**.

- `Assigned_Team_Problem.txt` (summary card): port closures, weather, **multi-modal shipment re-routing**, Air/Sea/Rail/Road.
- `problemstatement.md` (full official PS): every tool in §5 is **procurement** — inventory, POs, supplier catalog, RFQ, approval, ERP. Every scenario in §8 is a supplier disruption. **The §7 rubric has no re-routing category at all.**

**We are scored on the full PS. Build inbound component procurement.**

Satisfy the headline cheaply: every quote carries `transport_mode` (AIR / SEA / RAIL / ROAD) with its own lead time and cost. The solver already ranks on lead time and cost, so **mode selection falls out for free**. We claim "multi-modal" honestly and build no routing engine.

### Locked domain: automotive electronics manufacturing, Pune

The PS names it — `Pune-Plant-1`, `Smart Controller Unit`, `COMP-104 Motor Driver IC`, `Automotive-Grade`. Lean in.

Why this beats the alternatives:

| Domain | Verdict |
|---|---|
| **Automotive electronics, Pune** | **Locked.** Judges are in Pune; Chakan/Ranjangaon is a real auto belt. IATF 16949 / AEC-Q100 are real certifications, so the cert trap is believable not invented. JIT = low safety stock = native urgency. Line-stop cost is instantly legible. |
| Pharma cold chain | Good drama, but temperature excursion + shelf life is a whole extra state dimension. No time. |
| FMCG / grocery | High volume, low per-unit stakes, no certification story. Nothing to dramatize. |
| Aerospace | Best traceability story, but lead times in weeks. Kills urgency. |

**Fiction:** a tier-1 automotive electronics manufacturer, Pune-Plant-1, building Smart Controller Units and Battery Management Systems for EV two- and three-wheeler OEMs under SLA penalty.

**Scale:** 3 products · 6 components · 12 suppliers · 6 production orders. Small enough to seed in an hour, rich enough for every trap.

### Seed data — every trap gets a home

| Component | Trap it creates |
|---|---|
| COMP-104 Motor Driver IC | Canonical scenario. Requires AEC-Q100. |
| COMP-207 Li-ion Cell Module | **HAZMAT — air freight prohibited.** Kills the obvious expedite. |
| COMP-402 Microcontroller | Single-source, long lead → escalation is forced, not optional |
| COMP-118 Connector Set | Many suppliers, cheap → the split-sourcing showcase |
| COMP-520 Display Panel | Cheapest supplier has `quality_score = 0.62` |
| COMP-311 Wiring Harness | MOQ 1000 when we need 400 |

| Supplier | Role in the story |
|---|---|
| SUP-21 | Incumbent. **The liar** — claims dispatch, tracking shows label-only |
| SUP-42 | Certified, pricier, reliable → usually the correct answer |
| SUP-18 | Cheapest, no AEC-Q100 → the certification trap |
| SUP-33 | Fastest, `reliability = 0.55` → speed vs. risk tension |
| SUP-57 | High reliability, only 300 units available → forces the split |
| SUP-64 | MOQ 1000 → blocks the naive buy |

**Geography drives transport mode for free:** Shenzhen (SEA/AIR) · Taiwan (AIR/SEA) · Chennai (RAIL/ROAD) · Pune-local (ROAD). No routing logic needed — mode is an attribute of the supplier-to-plant lane.

The hazmat rule is ~5 lines in the constraint filter and it is the single most distinctive thing in the demo: for COMP-207 the fast option isn't expensive, it's **illegal**. The PS explicitly names "hazardous material transport rules" and nobody else will build it.

### Two conventions

**Currency: ₹ (INR), approval threshold ₹150,000.** This matches §5.8 of the full PS exactly. The summary card's `$50,000` contradicts it — the scenarios are built on the full PS's numbers, and ₹118 for a motor driver IC is plausible where $118 is not. Label the currency in the UI so there is no ambiguity.

**Simulated clock: 1 real second = 1 simulated hour.** A five-day supplier delay plays out in two minutes. Without this, urgency is invisible in a five-minute demo.

---

## 1. Final stack

**Keep**

- Frontend: React 19 (JSX) + Vite + Tailwind v4 + shadcn/ui + Radix + TanStack Query + Framer Motion
- Backend: FastAPI (REST + native WebSocket)
- Agent: LangGraph with Postgres checkpointer
- DB: Supabase Postgres — single source of truth
- Cache: Redis LangCache — extraction/classification calls only
- LLM: Gemini for all development and testing. Provider abstraction so Grok/Bedrock is a one-line swap.

**Cut**

- Embeddings / pgvector
- LangChain
- Redis locks, pub/sub, rate limiting
- Supabase Realtime (FastAPI owns the WebSocket)

**Architecture**

```
React (Vite) ──REST──▶ FastAPI ──▶ LangGraph agent ──▶ tools ──▶ Supabase Postgres
      ▲                    │                                        (ERP, audit,
      └──── WebSocket ─────┘                                          memory,
                                    LLM client ──▶ Redis LangCache    checkpoints)
```

**Hard rule:** only FastAPI writes to Postgres. The agent writes through tools. Every tool call emits an `audit_events` row. Nothing else.

---

## 2. Data model (Supabase)

```
components               id, name, requires_certifications[]
inventory                component_id, warehouse, erp_stock, usable_stock,
                         daily_usage, safety_stock, last_updated
suppliers                id, name, quality_score, reliability_score, certifications[]
supplier_catalog         supplier_id, component_id, unit_price, lead_time_days,
                         available_quantity, min_order_quantity
purchase_orders          id, component_id, supplier_id, quantity, expected_delivery,
                         status, unit_price, total_value
production_orders        id, product, required_component, units_planned,
                         component_per_unit, deadline, priority
messages                 direction(in/out), supplier_id, subject, body, ts
rfqs / quotes            rfq_id, supplier_id, quantity_available, unit_price,
                         delivery_days, expedite_fee, valid_until
shipment_tracking        po_id, supplier_claim, tracking_status, last_movement
approvals                id, incident_id, action, estimated_cost, brief,
                         status, decided_by, decided_at
incidents                id, type, severity, status, thread_id
audit_events             id, incident_id, ts, actor, event_type, payload  ◀ APPEND ONLY
supplier_memory          supplier_id, promises_made, promises_kept, avg_delay_days,
                         contradictions_detected, quality_failures, derived_reliability
scenario_runs            id, scenario_id, started_at, finished_at
run_scores               run_id, continuity, cost, risk, tool_eff, recovery, audit, total
```

**Two schema details that win points:**

1. `inventory.erp_stock` vs `inventory.usable_stock` — this *is* Scenario 2. The trap must exist in the schema or the agent can't detect it.
2. `audit_events` is append-only, enforced by RLS: `GRANT INSERT`, no `UPDATE`/`DELETE`. Say this out loud to judges — "the audit trail is immutable at the database level" is a 15-second line that lands.

### Event sourcing — one event, four representations

Never maintain separate human logs and developer logs. Emit once:

```json
{
  "sequence": 42,
  "incident_id": "INC-1001",
  "event_type": "OPTION_REJECTED",
  "actor": "solver",
  "human_summary": "SUP-18 rejected — lacks AEC-Q100 certification.",
  "technical_payload": {
    "supplier_id": "SUP-18",
    "constraint": "REQUIRED_CERTIFICATION",
    "required": ["AEC-Q100"],
    "actual": ["ISO-9001"]
  }
}
```

One row powers the human audit trail, the developer log, the WebSocket push, and the Decision Explorer.

**`sequence` must be a Postgres `BIGSERIAL`, never an app-side counter.** Concurrent tool calls will collide on an app counter and WebSocket replay ordering corrupts silently — you would find out as "the timeline is out of order" during judging.

LangGraph checkpoint tables are created by the checkpointer's `.setup()`. **Connect on port 5432 (direct/session), not 6543 (transaction pooler)** — the transaction pooler doesn't support prepared statements and the psycopg checkpointer will fail with a confusing error.

---

## 3. Agent graph (LangGraph)

```
INGEST → TRIAGE → INVESTIGATE → PLAN → VALIDATE ─┬─▶ APPROVAL (interrupt) ─┐
                       ▲                          └────────────────────────┤
                       │                                                   ▼
                       └──────── replan ◀──── VERIFY ◀──── EXECUTE ────────┘
                                                  │
                                                  ▼
                                                CLOSE
```

| Node | Work done by | What it does |
|---|---|---|
| `INGEST` | code | New event → `incidents` row, `thread_id = incident_id` |
| `TRIAGE` | LLM + code | LLM extracts structured signal from the message; **code** computes coverage days and assigns severity |
| `INVESTIGATE` | code → LLM → code | **Mandatory evidence pack fires first, in parallel** (inventory · production impact · originating PO/supplier). Then LLM does gap analysis and issues *conditional* calls only. Hard budget: 12 calls. |
| `PLAN` | **code** | Solver generates + ranks candidate recovery options |
| `VALIDATE` | **code** | Hard constraint gate. Rejects anything violating certs / MOQ / budget / safety stock |
| `APPROVAL` | LLM + `interrupt()` | If cost > threshold, LLM writes the brief and the graph halts |
| `EXECUTE` | code | Tools write PO / ERP updates |
| `VERIFY` | code + LLM | Cross-check tracking vs. supplier claim. Contradiction → update `supplier_memory` → **replan edge** |
| `CLOSE` | LLM | Writes the human-readable audit narrative |

`INVESTIGATE`'s tool budget is not a limitation — it's how you score Tool Efficiency (10%). Free-form ReAct loops burn calls; an explicit budget with a "why did you call this" audit line does not.

### The fast path is a conditional edge, NOT a second code path

```
Evidence pack (always, parallel) → gap analysis → ambiguity_flags
                                                       │
                          ┌──────── 0 flags ───────────┴────── >0 flags ──────┐
                          ▼                                                    ▼
                straight to PLAN                                     LLM investigation
                (~1 LLM call — the narrator)                         (conditional tools)
```

**Do not branch before LangGraph.** A separate deterministic path doubles the debugging surface — every bug becomes "which path did this take?" — and it can gut the demo, because if Scenario 1 routes deterministically the timeline streams four silent nodes and the agent looks like a script. Latency is not in the rubric. Same token savings, one graph.

---

## 4. The solver — your actual differentiator

Pure Python. No model. Unit tested. This is where 55% of the rubric lives.

```
Input: component_id, units_needed, deadline, budget_remaining,
       required_certs, production_priority

1. DEMAND
   shortfall = required_units − usable_stock + safety_stock_floor
   days_of_coverage = usable_stock / daily_usage

2. ENUMERATE CANDIDATES
   - every supplier carrying the component (single-source)
   - every 2-supplier combination (split-sourcing)   ◀ Layer 3, ~30 lines
   - "do nothing" baseline
   - "reschedule lower-priority production" baseline

3. HARD FILTER — record a rejection_reason for every candidate removed
   ✗ missing required certification
   ✗ quantity < min_order_quantity
   ✗ available_quantity insufficient
   ✗ lead_time_days > days_to_deadline
   ✗ total_cost > budget_remaining
   ✗ transport_mode == AIR and component.is_hazmat     ◀ COMP-207, ~5 lines

4. SCORE SURVIVORS — mirror the judges' own weights
   continuity = 1.0 if arrival ≤ deadline else 1.0 − (days_late × priority_penalty)
   cost       = 1.0 − (total_cost / baseline_po_value)
   risk       = reliability_score × quality_score
   score      = 0.35·continuity + 0.20·cost + 0.15·risk

5. RETURN ranked options + the full rejected list with reasons
```

**Step 5 is the whole game.** "Considered and rejected, and here is why" is what turns an audit trail from a log into an explanation. It's also the content of the best screen in your UI.

Split-sourcing unlocks Scenario 6 (12-hour line stop, partial shipments), which is the hardest scenario in the brief and the one most teams will skip.

---

## 5. Scenario injector — build this FIRST

Before the agent. Before the UI. The judges will inject hidden disruptions; if you can't inject them yourself you cannot test, cannot demo recovery, and will discover your replan edge is broken *during judging*.

Scenarios are JSON timelines against a simulated clock:

```json
{
  "id": "S3-adversarial",
  "events": [
    { "t": 0,   "type": "supplier_delay",        "po_id": "PO-7712", "days": 5 },
    { "t": 240, "type": "supplier_claim",        "po_id": "PO-7712", "claim": "dispatched" },
    { "t": 260, "type": "tracking_state",        "po_id": "PO-7712",
                "status": "label_created_no_pickup" }
  ]
}
```

Ship all six from §8 plus one `S7-chaos` that fires three at once.

Endpoints: `POST /api/scenarios/{id}/inject`, `POST /api/scenarios/reset` (re-seed from fixtures in under 2 seconds). Both wired to buttons in the UI.

---

## 6. Self-scorer — the thing nobody else builds

Implement their exact formula and run it after every scenario:

| Signal | How it's computed |
|---|---|
| Continuity | Did any production order miss its deadline? Weighted by priority. |
| Cost | Total spend ÷ known-optimal spend for that scenario |
| Supplier Risk | Did it detect the contradiction? Did it reject the uncertified supplier? |
| Tool Efficiency | `tool_calls / par_calls` for the scenario |
| Recovery | Did it replan after a mid-flight injection? |
| Audit | % of decisions carrying recorded rejection reasons |

Display it as a scorecard in the dashboard. You will be optimizing against the real rubric while every other team guesses — and showing judges you scored yourself is disarming.

---

## 7. Frontend — four screens, no more

1. **Live Incident Console** *(the demo screen)* — incident list left, agent timeline streaming over WebSocket in the center with node badges, current plan card right.
2. **Decision Explorer** *(the money screen)* — chosen option beside the rejected ones, each with its rejection reason. This screen is where 10% audit score and most of the judge's impression comes from.
3. **Approval Inbox** — pending approval with the LLM-written brief, Approve/Reject → resumes the halted LangGraph thread.
4. **Audit & Score** — immutable event log + the self-scorecard.

TanStack Query holds server state; the WebSocket **invalidates queries**, it does not carry state. One pattern, no divergence.

Framer Motion: timeline item entry + severity badge pulse. **Timebox: 45 minutes.** It is a trap.

---

## 8. API surface

```
POST   /api/scenarios/{id}/inject
POST   /api/scenarios/reset
GET    /api/incidents
GET    /api/incidents/{id}
GET    /api/incidents/{id}/audit
GET    /api/incidents/{id}/options       ← chosen + rejected with reasons
POST   /api/approvals/{id}/decide
GET    /api/score/{run_id}
GET    /api/inventory | /api/suppliers | /api/purchase-orders
WS     /ws/incidents                     ← agent event broadcast
```

Ten agent tools, all plain Python functions over Postgres: `get_inventory`, `get_production_schedule`, `get_purchase_orders`, `search_suppliers`, `request_quote`, `send_supplier_message`, `check_tracking`, `check_approval_threshold`, `update_erp`, `record_supplier_outcome`.

---

## 9. Build order (40h, 3 people)

| Phase | Hours | Deliverable |
|---|---|---|
| 0 · Foundation | 0–3 | Repo, Supabase schema, **Pune automotive seed data (6 components / 12 suppliers / 6 production orders)**, reset endpoint, simulated clock |
| 1 · **Injector** | 3–7 | 6 scenarios + event log. **Demo-able already.** |
| 2 · Tools | 7–12 | 10 tools over Postgres + audit event emission on every call |
| 3 · **Solver** | 12–17 | Solver + validator, pure Python, unit tested, run headless against all 6 scenarios — **no LLM yet** |
| 4 · Agent | 17–24 | LangGraph graph, Gemini provider, checkpointer, approval interrupt |
| 5 · Frontend | 24–32 | Four screens + WebSocket |
| 6 · Layer 3 | 32–36 | Self-scorer, supplier memory, replan edge, split-sourcing |
| 7 · Polish | 36–40 | Framer Motion, README + architecture diagram, **rehearse the demo three times** |

**Parallelize:** A = backend + agent · B = frontend · C = data, scenarios, scorer, demo script.

Note phase 3: the solver is validated **before any LLM is wired in**. If the solver is right, the agent is mostly right. If you wire the LLM first you will spend hours unable to tell whether a bad decision came from the model or the math.

---

## 10. Demo script (5 minutes)

| Time | Beat |
|---|---|
| 0:00 | Dashboard, healthy state, live inventory |
| 0:30 | Inject Scenario 1 — agent detects, timeline streams node by node |
| 1:30 | Decision Explorer — "here is what it rejected and why" |
| 2:15 | Inject Scenario 3 mid-flight — supplier claims dispatched, tracking contradicts, **agent replans live** |
| 3:15 | `supplier_memory` reliability score visibly drops for SUP-21 |
| 3:45 | Scenario 5 — cost crosses ₹150,000, approval brief appears, human approves, graph resumes from checkpoint |
| 4:15 | **Hazmat beat** — COMP-207: agent rejects the fastest option because Li-ion cannot fly. Not expensive — *prohibited*. |
| 4:30 | Immutable audit trail + self-scorecard |

Closing line: *"The deterministic core means it cannot violate a constraint. The LLM does the judgment and the explaining. That's the split that makes it trustworthy enough to actually run."*

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| **Supabase project is paused** and the project ref in `.mcp.json` returns permission denied | **Blocker — resolve before phase 0.** Un-pause and confirm the correct ref. |
| LangGraph checkpointer fails on Supabase pooler | Use port 5432 direct/session connection, not 6543 |
| Accidental Bedrock usage | Provider abstraction, Gemini key only in `.env`, Bedrock path unimplemented |
| Demo venue has no internet | Record a full run as fallback video; keep a local Postgres seed |
| Framer Motion eats the last four hours | Hard 45-minute timebox, cut on sight |
| Scope creep into embeddings / vector memory | Already cut. Do not reopen. |

---

## 12. Explicitly not building

Embeddings and pgvector · LangChain · Redis pub/sub, locks, rate limiting · Supabase Realtime · multi-tenant auth · real carrier APIs · mobile layout · dark mode toggle (pick one theme and commit) · **a routing/optimization engine for transport modes** (mode is a lane attribute, not a computation) · **a second deterministic code path outside LangGraph**.
