# DisruptionOps — Build Tasks

**Product:** Autonomous supply-chain control agent for NEXA Mobility Systems, a Pune-based
Tier-1 automotive electronics manufacturer.

**Theme:** Apple-style glassmorphism. Black + lime (dark), white + lime (light). Both modes.

Ordered by **score-per-hour**, not by architectural elegance. Ship top-down.

---

## RULE 0 — Do not rebuild the schema

The N3 conceptual model is better on paper. Renaming `suppliers` → `supplier`,
`inventory` → `inventory_balance` etc. is a cascade through solver, injector, scorer, seed,
and every endpoint — all currently tested and working.

**Instead:** additive tables for new loops + a thin display layer for naming.
Same user-visible outcome, ~2% of the risk.

**Also:** SMTP to real recipients is out. The PS requires a simulated sandbox and warns against
connecting real email. Keep the email *aesthetic* (From/To/Subject, delivery states) — drop the
transport. "One config flag from real SMTP" is a stronger claim than shipping it.

---

## T1 — Reactive controller  ⭐ HIGHEST SCORE IMPACT

Today a human clicks **Solve**. That reads as not-agentic. This is 40% (autonomous decision) +
30% (robustness) of the summary rubric.

```
Event lands
   ↓
Risk detector  (deterministic)
   ↓
Does this threaten production?   ── no ──▶  log + monitor
   ↓ yes
Open incident automatically
   ↓
Wake agent
```

- [ ] `app/risk.py` — `assess(event) -> RiskVerdict{severity, threatened_orders, hours_to_impact}`
- [ ] Hook into `injector.apply_event` — every event runs through the detector
- [ ] Auto-open incident when severity ≥ high; auto-attach to existing incident otherwise
- [ ] Emit `RISK_DETECTED` and `AGENT_WOKE` audit events
- [ ] Agent runs the evidence pack automatically on wake (no button)
- [ ] Remove **Solve** as the primary trigger; keep it as a manual re-run

**Done when:** injecting S1 produces a recovery plan with zero clicks.

---

## T2 — Communication threads (supplier · warehouse · carrier)

The most *visible* agentic behaviour. Agent writes, supplier replies, agent catches the lie.

### Schema (additive)

```sql
create table message_threads (
  id bigserial primary key,
  incident_id text,                       -- soft ref, no FK (audit rule)
  counterparty_type text not null,        -- supplier | warehouse | carrier | internal
  counterparty_id text,
  subject text not null,
  status text not null default 'open',
  created_at timestamptz default now()
);

create table messages (
  id bigserial primary key,
  thread_id bigint references message_threads(id) on delete cascade,
  direction text not null,                -- outbound | inbound
  author_type text not null,              -- agent | supplier | warehouse | carrier | human
  author_id text,
  body text not null,
  delivery_state text not null default 'sent',
  -- draft | sent | delivered | replied | awaiting_response | expired | escalated
  sent_at timestamptz default now(),
  responded_at timestamptz,
  simulated_at_seconds numeric(12,2)
);
```

- [ ] `send_supplier_message` tool → writes outbound + schedules a simulated reply
- [ ] Supplier reply simulator with per-supplier persona (SUP-21 lies; SUP-42 is straight)
- [ ] Parallel RFQ: agent contacts 3 suppliers via `asyncio.gather`
- [ ] **Follow-up loop** — no reply within N simulated minutes → chase → chase again → lower confidence → route around
- [ ] Delivery states drive UI (`awaiting_response` shows a spinner)
- [ ] Every message emits an audit event

### UI — Communication Center
- [ ] One chronological operational thread per incident: supplier + warehouse + carrier + agent + human
- [ ] Email-style rendering (From / To / Subject / body / timestamp)
- [ ] `sheet` component, opens from the incident rail

**Done when:** the demo shows the agent asking SUP-21 for pickup time, SUP-21 claiming dispatch,
and the agent flagging the contradiction — as a readable conversation.

---

## T3 — Human-readable naming layer

Nobody should have to hold `PROD-882` in their head.

```sql
alter table components add column display_name text;   -- 'Motor Driver IC'
alter table components add column part_number text;    -- 'MDIC-7701'
alter table components add column category text;       -- 'Power Electronics'

create table products (
  id text primary key,
  name text not null,          -- 'EV Drive Controller'
  family text                  -- 'EV Power Electronics'
);
alter table production_orders add column product_id text references products(id);
alter table suppliers add column legal_name text;      -- 'Shenzhen Motion Electronics'
```

- [ ] Backfill in `seed.sql`
- [ ] `/api/*` returns display names alongside IDs
- [ ] **UI rule: name first, ID as grey metadata.** Never an ID alone in a heading.

Before → after:

```
PROD-882 requires COMP-104
→ High-priority EV Drive Controller order needs 460 more Motor Driver ICs
  COMP-104 · MDIC-7701 · Power Electronics
```

---

## T4 — Warehouse loop + Warehouse UI

Physical reality contradicting ERP. Closes the strongest loop after supplier.

```sql
create table warehouse_tasks (
  id bigserial primary key,
  facility_id text references warehouses(id),
  component_id text references components(id),
  incident_id text,
  task_type text not null,
  -- physical_count | usable_stock_verification | quality_hold_check
  -- release_stock | receive_shipment | verify_lot
  priority text not null default 'normal',
  status text not null default 'open',      -- open | in_progress | done | cancelled
  requested_by text not null default 'agent',
  instructions text,
  result_payload jsonb,
  created_at timestamptz default now(),
  completed_at timestamptz
);
```

Keep the three concepts separate — **message = communication · task = requested action · event = immutable history.**

- [ ] `request_warehouse_task` agent tool
- [ ] Warehouse route `/warehouse` — inventory · inbound · tasks · quality holds
- [ ] Operator can submit a physical count → becomes an event → agent recalculates coverage live
- [ ] Quality hold: received ≠ usable
- [ ] No map on the warehouse screen. Map belongs to Command Center.

**Demo moment:** warehouse submits "390 usable, 410 quarantined" → Command Center KPI updates in
real time → agent re-plans. That is the loop closing on screen.

---

## T5 — Verification loop (incident lifecycle)

Executed ≠ resolved. Prevents a fake "problem solved".

```
OPEN → INVESTIGATING → PLANNED → EXECUTING → MONITORING → VERIFIED?
                                                    ├── yes → CLOSED
                                                    └── no  → REOPEN → replan
```

- [ ] Extend `incident_status` enum
- [ ] Incident closes only when **usable** stock covers the requirement
- [ ] Auto-reopen when a recovery PO is itself delayed or fails inspection
- [ ] `INCIDENT_REOPENED` audit event

---

## T6 — Approval Center

- [ ] `/approvals` route
- [ ] Approve · Reject · **Modify** ("approve SUP-42 only, drop SUP-33")
- [ ] Modify writes a *constraint* into agent state → invalidates plan → forces replan
- [ ] LangGraph `interrupt()` resume on approve
- [ ] Escalation chain on no acknowledgement (compressed: T+5 simulated minutes)

Human feedback must change agent state, not sit as a comment.

---

## T7 — Command Center redesign + light/dark

Current UI is card-heavy and too dense. Target: more whitespace, bigger type, fewer cards.

```
┌──────────────────────────────────────────────────────────────┐
│ Command Center              Pune Plant · LIVE · 19:24 IST    │
├──────────────────────────────────────────────────────────────┤
│  🔴 1 CRITICAL        4.3 DAYS           ₹67,500             │
│  Production risk      Production cover   Best recovery       │
├────────────────────────────────┬─────────────────────────────┤
│         LIVE SUPPLY MAP        │ CURRENT INCIDENT            │
│                                │ Motor Driver IC             │
│                                │ 460 units exposed           │
│                                │ Agent is working…           │
├────────────────────────────────┴─────────────────────────────┤
│ AGENT ACTIVITY                                               │
│ 19:22 ✓ Delay detected                                       │
│ 19:23 ⚠ Tracking contradiction detected                      │
│ 19:23 ◌ Evaluating alternatives                              │
└──────────────────────────────────────────────────────────────┘
```

Sidebar groups:

```
OPERATIONS      Command Center · Live Network · Incidents
DECISIONS       Decision Explorer · Approvals · Audit Trail
INTELLIGENCE    Ask the Agent · Agent Activity · Performance
WAREHOUSE       Inventory · Tasks · Inbound
```

- [ ] shadcn `sidebar` block (collapsible groups)
- [ ] Theme toggle — `switch` + `dropdown-menu`, class on `<html>`, persisted
- [ ] **Verify light mode.** Glass tokens are currently tuned for dark only.
- [ ] Agent activity in plain language, not event types:
      *"Checked usable inventory"* not `INVENTORY_QUERIED`
- [ ] Expandable **"Why did the agent do this?"** → prose reasoning
- [ ] **Developer Trace** toggle → raw JSON, node names, tool counts, latency

---

## T8 — Geography  ✅ done

Mapbox GL, not MapLibre — the user supplied a Mapbox token, and Mapbox's own tile CDN is
one less thing to go wrong on conference wifi.

**The schematic stays the default.** Real geography is a second opinion, not the primary
view: an operator reading lanes does not need coastlines, and the SVG projection renders
instantly with no network at all.

- [x] `NetworkFlow.jsx` — SVG projection with rich hover detail on every node, lane and
      shipment (supplier trust, fastest lane, contradiction count, transport modes,
      components supplied, active shipments and their value)
- [x] `MapView.jsx` — Mapbox GL, **Live Network screen only**, behind a Schematic/Geography
      toggle
- [x] Lazy chunk: the ~800 kB map engine never enters the main bundle, and only loads if
      someone actually opens the map
- [x] Automatic fallback to the schematic when the token is missing, the chunk fails, or
      tiles are unreachable — with a quiet note saying why
- [x] Quadratic-bezier lane arcs, tone-coded by state, red ping on contradicted suppliers
- [x] Mapbox layout CSS inlined in `index.css` so the map does not depend on the vendor
      stylesheet resolving
- [ ] Animated shipment position along the route (deterministic: position is a function of
      simulated elapsed time, never random GPS)
- [ ] `shipment_positions` table wired to the map
- [ ] Geographic contradiction: supplier says in-transit, GPS shows no movement

> Conference wifi risk is handled by construction — if tiles fail the schematic takes over
> automatically and the demo continues. The map can never take the demo down.

---

## T8b — Decision Explorer v2  ✅ done

- [x] Production-run picker (names and OEM customers, not typed `PROD-882`) — opens on the run
      in the most trouble
- [x] **Comparison matrix**: every costed option as a column, criteria as rows — weighted score,
      units covered, arrival vs deadline, total cost, the three rubric sub-scores, authority,
      who supplies it, and the reasoning
- [x] Refusals are first-class: "considered and refused" with the human reason per supplier
- [x] **What-if**: click a supplier to knock it out. `exclude` removes it from the candidate pool
      *before* scoring, so the plan re-forms around the loss — split-sourcing re-plans instead of
      a row simply disappearing
- [x] Deltas against the real plan (cost, arrival, score), coloured by whether they hurt
- [x] Simulations never write to the audit log (`record` is ignored when `exclude` is set)
- [x] Backend: `solve_for_production_order(..., exclude=[...])`, `GET /api/solve/{id}?exclude=A,B`,
      response gains `suppliers_in_play` and `excluded`

Verified against the solver directly: knocking out the chosen supplier re-plans onto the next
viable one; knocking out both viable ones correctly returns **Do nothing — the line stops**,
rather than inventing a recovery.

---

## T9 — Production ↔ Procurement loop  ✅ done

Until this, the agent had exactly one answer to a shortage: **buy more**. Now it has a second
lever — ask whether a lower-priority run can wait, and spend the freed units instead of money.

**How it is modelled honestly.** Usable stock is a shared pool, and each open run holds a claim
on it (`production_orders.allocated_units`). A shortfall may only count stock nobody else has
claimed. Releasing a claim is exactly what a reschedule does — no hand-waving about units
appearing from nowhere.

- [x] `allocated_units`, `original_deadline`, `rescheduled_at`, `rescheduled_reason` on
      `production_orders`
- [x] `NEED_SQL` is allocation-aware: available = pool − claims held by other live runs
- [x] `RESCHEDULE_SQL` finds runs that could stand down — strictly lower priority, holding units,
      and with real slack in their own deadline (the delay we ask for *is* that slack, capped at
      14 days)
- [x] New option kind `reschedule_other`, scored on the same weights as everything else, with the
      residual purchase costed inside it
- [x] **Always requires approval**, however little it costs — the delay lands on another
      customer, and that is not a trade an agent makes alone. The approval reason says so in
      those words instead of quoting a spending limit.
- [x] `POST /api/production/reschedule` for the operator-driven path; agent-driven execution
      stands the run down *before* buying the smaller residual, and replans if someone else
      rescheduled it first
- [x] `PRODUCTION_RESCHEDULED` audit event, and the reschedule re-wakes the agent so it never
      holds a stale plan
- [x] Decision Explorer: "Where units come from" credits the released stock, and a **"Who else
      pays"** row names the customer and the days — the cost that is not money
- [x] Seed: **PROD-888**, low-priority aftermarket spares for Shakti Auto, holding 300 units of
      COMP-104 with 17 days of slack

Verified end to end: for PROD-882 the loop produces *"Delay Smart Controller Unit for Shakti Auto
+ buy 160"* at **₹43,200 / score 0.657**, beating the cheapest straight purchase at **₹86,700 /
score 0.582** — and still stops for a human.

---

## T10 — Supplier learning loop  ✅ done

Trust used to be a one-way ratchet: every contradiction subtracted 0.25, every quality failure
0.15, and nothing ever earned any of it back. A supplier who slipped once in March stayed
punished forever, and one who quietly delivered forty times on schedule accumulated no credit.

- [x] `supplier_trust()` — the arithmetic lives in **SQL**, so Python can never drift from it.
      Laplace-smoothed keep rate toward the seeded prior, minus 0.20 per contradiction, 0.10 per
      quality failure, 0.02 per average day late
- [x] `reliability_events` — every movement with a before, an after, and a reason. Without it the
      score is an opinion; with it, it is an argument the operator can check
- [x] `app/learning.py` — the **only** writer of `supplier_memory`. Three call sites that each
      hand-rolled their own subtraction now record what happened and let the score follow
- [x] `on_goods_received()` closes the loop: on-time delivery is the one event that raises trust,
      measured in hours against the promise, never truncated days
- [x] `supplier_effective` recomputes rather than reading whatever the last subtraction left
- [x] `GET /api/suppliers/{id}/reliability` returns the score *and* its history
- [x] `SUPPLIER_LEARNED` audit events, and hover cards that show why the number moved

---

## UX pass — from system console to operations copilot

The critique was right: the product exposed what the agent was doing rather than answering what
an operator actually asks. Reordered around **situation → impact → recommendation → your action
→ evidence**.

- [x] **NOW bar** — persistent strip: what needs you, what the agent is doing, days of cover,
      next delivery. Always the same place, always the same question answered
- [x] **Overview rebuilt into three zones** — left: an action *queue* (not a feed) that shrinks as
      you work it; centre: one operational story with the have → need → short arithmetic in
      plain numbers; right: what the AI is doing in three tenses — done, waiting on, next
- [x] **⌘K command bar** — "Ask the Agent" was a page you had to leave your work to reach, which
      is backwards. Now it is one keystroke from anywhere, does navigation too, and shows what
      the answer was grounded in
- [x] **Navigation regrouped** by user question, not architecture: Operations · AI agent ·
      Execution · Governance
- [x] **Whitespace pass** — panel headers and card bodies were all running dense; loosened
      consistently across every screen
- [x] **Hovers answer "and what did you do about it?"** — both the schematic and the Mapbox view
      now show the agent's last five actions with that supplier, the delivery record, and why the
      trust score moved

### Still to do — the rest of the critique

- [ ] Incident page as the main operational workspace (header → what changed → recommendation →
      collapsed activity)
- [ ] Decision Explorer led by the recommendation, with the scoring matrix behind a drill-down
- [ ] Communications as an inbox: `Needs reply` / `AI conversations` / `Warehouse` tabs, and an
      explicit autonomous / draft-only / human-takeover mode per thread
- [ ] Warehouse reduced to *My Tasks* — a warehouse operator should never see a weighted score
- [ ] Network dims everything not on the affected path when a disruption is live
- [ ] Audit Trail split into Business / Agent / Technical views
- [ ] Simulation transport controls — play, pause, speed, scrub
