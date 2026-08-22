# Supply Chain Disruption Control Agent

Autonomous procurement recovery agent for **Pune-Plant-1**, a tier-1 automotive
electronics manufacturer. Detects supply disruptions, verifies supplier claims
against carrier data, generates constraint-compliant recovery plans, and escalates
to a human when the cost crosses ₹150,000.

**Team kala dhua** · Hackers Occupied Pune 2026

---

## The one design decision

70% of the judging rubric is decision quality measured as numbers — production
continuity (35%), cost control (20%), supplier risk (15%). Every hidden test is a
constraint trap.

So **the decision is made by deterministic Python, not by an LLM.**

| Seat | Who |
|---|---|
| Parse vague supplier email, spot contradictions | LLM |
| Decide which tools to call | LLM |
| Generate + rank recovery options | **`solver.py` — no model** |
| Enforce hard constraints | **`solver.py` — no model** |
| Write the audit narrative and approval brief | LLM |

Constraint compliance becomes provable rather than hopeful, and swapping
Gemini → Grok → Bedrock is a config change, not a re-validation.

---

## Setup

### 0. Prerequisites

Node 20+, Python 3.11+, and a Supabase project.

### 1. Database

Run in the Supabase SQL editor, in order:

```
supabase/migrations/0001_init.sql
supabase/migrations/0002_run_linkage_sim_time_and_authority.sql
supabase/migrations/0003_audit_log_survives_reset.sql
supabase/seed.sql
```

Verify the traps are reachable — this must return **460**:

```sql
select po.units_planned * po.component_per_unit - i.usable_stock + i.safety_stock as shortfall
  from production_orders po
  join inventory i on i.component_id = po.required_component
 where po.id = 'PROD-882';
```

### 2. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r requirements.txt

copy .env.example .env          # then fill in DATABASE_URL
uvicorn app.main:app --reload --port 8000
```

**`DATABASE_URL` must use port 5432**, not 6543. Supabase → Project Settings →
Database → Connection string → URI. The 6543 transaction pooler has no
prepared-statement support and the LangGraph checkpointer breaks on it later.

```
postgresql://postgres:<PASSWORD>@db.<ref>.supabase.co:5432/postgres
```

Check it: <http://localhost:8000/api/health> → `{"ok": true, "suppliers": 12, ...}`
Interactive API docs: <http://localhost:8000/docs>

### 3. Frontend

```bash
cd frontend
npm install
npm install @tanstack/react-query class-variance-authority clsx tailwind-merge \
  lucide-react tw-animate-css @radix-ui/react-slot @radix-ui/react-tabs \
  @radix-ui/react-select @radix-ui/react-separator @radix-ui/react-scroll-area \
  @radix-ui/react-progress

copy .env.example .env
npm run dev
```

Open <http://localhost:5173>.

> **On shadcn/ui:** the components in `src/components/ui/` are the standard
> shadcn "new-york" primitives, already written to disk with `components.json`
> configured. You do **not** need to run `npx shadcn init`. To add more
> components later, `npx shadcn@latest add dialog` works against the existing
> config.

---

## Using the dashboard

| Panel | What it does |
|---|---|
| **Inject disruption** | Seven scenario buttons. Each plays a timed event sequence against the simulated clock. |
| **Custom event** | Fire any of the 10 event types by hand with JSON params. Same code path as scenarios. |
| **Manual log** | Type a note; it becomes a first-class `audit_events` row and appears in the timeline. |
| **Agent timeline** | Live WebSocket stream. Every row shows sequence, simulated time, run id, actor, and an expandable technical payload. |
| **Decision explorer** | Runs the solver. Shows what was chosen **and everything rejected, with the constraint that killed it**. `+ audit` writes the reasoning into the audit trail. |
| **Self-scored runs** | Scores each run with the judges' own formula. |
| **World state** | Inventory (ERP vs usable, coverage days), purchase orders (red when supplier claim contradicts carrier), supplier trust scores. |

### Reset modes

- **Reset** (`mode=demo`) — re-seeds operational tables. **Run history is preserved**,
  so you keep the comparisons you are tuning against.
- **Hard** (`mode=hard`) — also wipes `scenario_runs`, `run_scores`, `audit_events`.
  Between dev sessions only. Never mid-tuning, never on demo day.

### Clock

Default 1 real second = 1 simulated hour, so a five-day delay plays out in two
minutes. Change with `CLOCK_SECONDS_PER_SIM_HOUR`, or live:

```bash
curl -X POST "localhost:8000/api/clock/rate?seconds_per_sim_hour=0.3"
```

---

## The scenarios

| Id | Tests |
|---|---|
| `S1-normal-disruption` | Baseline triage, coverage math, alternate sourcing |
| `S2-stale-inventory` | ERP says 800, warehouse says less — who does it believe? |
| `S3-adversarial` | Supplier claims dispatch, carrier shows label-only |
| `S4-quality-constraint` | Cheapest source fails incoming inspection |
| `S5-budget-approval` | Recovery crosses ₹150,000 — brief, don't spend |
| `S6-line-stop` | 12 simulated hours. Partial shipments and split sourcing |
| `S7-chaos` | All of it at once, with repeated replanning |

---

## Why the seed data looks wrong

It isn't. Every awkward number makes a specific trap reachable. For PROD-882 the
shortfall is 460 units, and:

| Supplier | ₹/u | Fate |
|---|---:|---|
| SUP-18 | 108 | **rejected** — cheapest in the set, no AEC-Q100 |
| SUP-21 | 118 | **rejected** — 7-day lead, too slow |
| SUP-64 | 120 | **rejected** — MOQ 1000 against a need of 460 |
| SUP-42 | 132 | partial — certified and reliable, only 300 available |
| SUP-57 | 138 | partial — most reliable, exactly 300, MOQ 300 |
| SUP-33 | 145 | eligible — fastest, reliability 0.55 |

The three rejection classes fire on the three cheapest suppliers. A solver that
sorts by price hits a wall three times.

`COMP-207` is Li-ion and flagged `is_hazmat`. Its best supplier on paper —
SUP-71, ₹845, 2-day lead — has exactly one transport lane: `AIR`. For hazmat that
is **prohibited, not expensive.** Do not "fix" this.

---

## Architecture

```
React + Vite + shadcn/ui ──REST──▶ FastAPI ──▶ solver ──▶ Supabase Postgres
        ▲                             │                    (ERP, audit, memory)
        └────── WebSocket ────────────┘
```

- **One database.** Supabase Postgres is the source of truth.
- **One broadcast path.** FastAPI owns the WebSocket. No Supabase Realtime, no Redis pub/sub.
- **One writer.** Only FastAPI writes. The audit trail is append-only, with no
  UPDATE/DELETE grant anywhere.
- **One event, four representations.** `audit_events` carries `human_summary` and
  `technical_payload`; the human trail, developer log, WebSocket push and Decision
  Explorer all render the same row. There is no separate human log.

`sequence` is `BIGSERIAL` so concurrent tool calls cannot corrupt replay ordering.
`run_scores.total` is a **generated column** computing the judges' weighted formula
in Postgres, so the weights cannot drift between the scorer and the database.

---

## Hard-won details

Things that were bugs, are now fixed, and will come back if someone "tidies" them:

- **All time comparisons are in hours.** `extract(day from deadline - now())`
  truncates and spuriously rejects a supplier whose lead time exactly meets the
  deadline.
- **Lateness is a cost, not a prohibition.** Certification, hazmat, MOQ and budget
  are hard constraints. Arriving late is scored with a priority-weighted penalty.
  Hard-rejecting it made the 12-hour line-stop scenario return "do nothing".
- **`cost_score` is a ratio**, not `1 − (cost / baseline)`. The subtractive form
  clamps to zero for every option above baseline and stops discriminating.
- **`audit_events.incident_id` is not a foreign key.** `ON DELETE SET NULL` does not
  protect against `TRUNCATE ... CASCADE`.
- **`supplier_effective` is the only supplier trust source.** `suppliers.reliability_score`
  is a seeded prior; `supplier_memory.derived_reliability` is authoritative. Never
  join `suppliers` directly in the solver.

---

## API

```
GET    /api/health
GET    /api/clock                      POST /api/clock/rate?seconds_per_sim_hour=
GET    /api/scenarios                  GET  /api/scenarios/{id}
POST   /api/scenarios/{id}/inject
POST   /api/scenarios/reset?mode=demo|hard
POST   /api/events/custom              { type, params }
POST   /api/logs                       { text }
GET    /api/incidents
GET    /api/audit?run_id=&incident_id=&after=&limit=
GET    /api/world
GET    /api/solve/{production_order_id}?record=true
GET    /api/runs                       POST /api/runs/{id}/score
WS     /ws
```

---

## Status

Done: schema, seed, scenario injector, deterministic solver, self-scorer,
WebSocket event bus, shadcn dashboard.

Next: LangGraph agent loop (evidence pack → gap analysis → conditional
investigation → solver → validate → approval interrupt → verify → replan),
supplier-message simulator with scripted replies, and the approval inbox.

**Gemini only for development and testing. Do not wire Bedrock.**
