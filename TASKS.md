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

## T8 — MapLibre + OpenStreetMap

- [ ] Replace the projection SVG with MapLibre GL
- [ ] Markers: 🏭 plant · 🟢 supplier · 🔵 shipment · 🔴 disruption · 🟣 alternate
- [ ] Animated shipment position along route
- [ ] **Deterministic movement, never random GPS.** Position is a function of simulated
      elapsed time over the route.
- [ ] `shipment_positions` table (lat, lng, recorded_at, source)
- [ ] Contradiction is geographic: supplier says in-transit, GPS shows no movement

> ⚠️ Conference wifi risk. Cache the style JSON locally and keep the current SVG projection
> as an automatic fallback if tiles fail to load. Do not let the map take the demo down.

---

## T9 — Production ↔ Procurement loop  (the strategic one)

Without this the system only knows one answer: *buy more*.

```
SHORTAGE → ask production planner → "can we delay the lower-priority order?"
        → component demand recalculates → agent replans procurement
```

- [ ] `production_reschedule` tool
- [ ] Solver gains a real reschedule option: delay Order B, need 200 not 460, avoid air freight
- [ ] Requires Plant Manager approval when it delays another customer order

This is what separates a **procurement agent** from an **operations agent**. Worth doing the
moment T1–T6 are stable.

---

## T10 — Stretch

- [ ] **Supplier learning loop** — promised 2 days, took 6 → reliability drops → future decisions change
- [ ] **Ask the Agent** chat — read / control / constrain / approve / investigate.
      Constraints must pass deterministic authorisation, and must invalidate the current plan.
- [ ] **Policy loop** — temporary limit raise (₹250k for 24h) makes a rejected plan executable
- [ ] **OEM negotiation** — "can you accept 24h late?" turns time into a lever alongside cost
- [ ] Notification → acknowledgement → escalation chain

---

## Performance

- [ ] `asyncio.gather` for the evidence pack — 4×500ms sequential becomes ~500ms
- [ ] Redis cache: supplier catalog · component metadata · map locations · active incident summary · agent task state
- [ ] **Never cache:** inventory truth · financial state · audit events. Supabase stays source of truth.
- [ ] Redis LangCache on extraction/classification LLM calls only — never on decisions

---

## shadcn components to install

```bash
npx shadcn@latest add sheet dialog dropdown-menu tooltip sonner avatar \
  skeleton alert command popover switch collapsible resizable sidebar
```

| Component | Used for |
|---|---|
| `sidebar` | Grouped nav — the whole T7 restructure |
| `sheet` | Incident drawer, communication thread |
| `switch` + `dropdown-menu` | Light/dark toggle |
| `sonner` | Agent notifications ("contradiction detected") |
| `command` | ⌘K jump to component / supplier / incident |
| `dialog` | Approval modal |
| `skeleton` | Loading states — kills the "Loading network…" text |
| `alert` | Critical production risk banner |
| `avatar` | Message thread participants |
| `tooltip` · `popover` · `collapsible` · `resizable` | Detail on demand, split panes |

---

## Seed data — rich, but invisible

Expand to ~4 products, 12 components, 15 suppliers, 8 production orders, 6 shipments.
Add message history and past incidents so supplier reliability has real provenance.

**Do not build a UI to browse seed data.** The user should only ever see the *consequences* of
it. One line in the footer is enough: *"Simulating NEXA Mobility Systems · Pune Plant · 15 suppliers."*
