# DisruptionOps

**An autonomous supply-chain disruption control agent.**
Team **kala dhua** · Hackers Occupied Pune 2026

A Tier-1 automotive electronics plant loses a shipment. Somebody has to notice, work out
whether a production line is about to stop, find another way to get the parts, refuse the
options that are illegal or uncertified, and know when the decision is too big to make alone.

DisruptionOps does that without being asked. **Nobody presses a Solve button.**

---

## The one idea that matters

> **The LLM investigates, interprets and explains. Deterministic Python decides.**

Every constraint check, every cost comparison and every choice happens in ordinary Python you
can read in `backend/app/solver.py`. The language model reads supplier emails, spots
contradictions, and writes explanations — it never gets to pick a supplier or approve a spend.

This is not caution for its own sake. A model doing arithmetic over changing state will
eventually buy an uncertified part or put lithium cells on a plane. A filter cannot.

---

## Run it in five minutes

**Prerequisites:** Python 3.11+, Node 20+, and a Postgres database (we use Supabase).

```bash
git clone <this repo> && cd HACKERS_OCCUPIED_KALA_DHUA
```

### 1. Database

```bash
# Apply migrations in order, then the seed:
psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
psql "$DATABASE_URL" -f supabase/migrations/0002_run_linkage_sim_time_and_authority.sql
psql "$DATABASE_URL" -f supabase/migrations/0003_audit_log_survives_reset.sql
psql "$DATABASE_URL" -f supabase/migrations/0004_geo_coords_for_network_view.sql
psql "$DATABASE_URL" -f supabase/migrations/0005_business_naming_and_closed_loops.sql
psql "$DATABASE_URL" -f supabase/migrations/0006_production_reschedule_loop.sql
psql "$DATABASE_URL" -f supabase/migrations/0007_supplier_learning_loop.sql
psql "$DATABASE_URL" -f supabase/migrations/0008_supplier_portal_autonomy_and_human_input.sql
psql "$DATABASE_URL" -f supabase/seed.sql
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env          # then edit it
uvicorn app.main:app --reload --port 8000
```

`backend/.env`:

```
DATABASE_URL=postgresql://user:pass@host:6543/postgres
GEMINI_API_KEY=...            # optional — see "Running without an LLM" below
GEMINI_MODEL=gemini-3.6-flash
LLM_ENABLED=true
```

> **If you use Supabase**, connect through the **IPv4 transaction pooler on port 6543**.
> `db.<ref>.supabase.co` resolves IPv6-only and will fail with `getaddrinfo failed` on most
> networks. The pooler is safe here because the connection sets `statement_cache_size=0`.

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env          # VITE_API_BASE, optional VITE_MAPBOX_TOKEN
npm run dev                   # http://localhost:5173
```

### Running without an LLM

Set `LLM_ENABLED=false`, or just leave `GEMINI_API_KEY` unset. **Every LLM call has a
deterministic fallback** and the system runs end to end without a model — you lose the prose
explanations and the message interpretation, and keep every decision. The badge in the top bar
reads `deterministic` instead of the model name so you always know which mode you are in.

This matters for grading: none of the decision quality depends on a network call succeeding.

---

## Testing it — start here

Open the dashboard and click **Run simulation** in the top bar.

The drawer shows every built-in scenario, **what it feeds in and when**, in plain language.
Pick one and press Run. One real second is one simulated hour.

### Three windows — the demo that matters

The agent does not "get" a stock figure, or a supplier's price, because the demo hands
it one. It has to ask a **different human at a different screen**, and wait.

| Window | URL | Who |
|---|---|---|
| Operations | `http://localhost:5173/` | The supply-chain manager |
| Warehouse | `http://localhost:5173/warehouse` | The floor at Pune Plant |
| Supplier | `http://localhost:5173/supplier/SUP-21` | A vendor, answering in their own words |

Open them side by side. Nothing is piped between tabs — every one of these goes through
the database and the agent, which is the only reason the loops are testable rather than
asserted.

**Warehouse.** Run a scenario in the first window; a task appears in the second within a
second, over the same WebSocket. Type a count that contradicts the ERP, press **Send to
the agent**, and watch the plan change. The agent never writes warehouse truth: it raises
a task, a human answers, the answer becomes evidence, the world updates, the agent
observes. An agent that could set `usable_stock` itself would only be pretending to
verify anything.

**Supplier.** This is the harder half, and the one that used to be a lie of omission.
"The supplier claims dispatch and the agent catches it" was a persona firing a hardcoded
string at a timer — a scripted liar proves nothing about an agent, and a judge had no way
to disagree with it. Now *you* decide whether to tell the truth:

- **Quote** — quantity, price, lead time, mode, MOQ, certifications. An applied quote is
  written through to `supplier_catalog`, which is what the solver reads, so dropping your
  price moves the recommendation on the operations screen while you watch.
- **Hedge** — "we may be able to arrange around 500 units, subject to confirmation".
  Numbers present, commitment absent. The agent parses it, refuses to treat it as supply,
  and raises a question rather than guessing.
- **Decline** — an honest no removes you from the pool instead of leaving the solver
  costing an option that does not exist.
- **Claim a dispatch** — including one that never happened. The carrier system is not
  yours to edit, so the contradiction is real and the agent finds it by checking rather
  than by being told.

**While a supplier portal is open, that supplier's scripted persona stands down** and the
agent genuinely waits for a person. Close the tab and the personas resume, so an
unattended demo still runs end to end. Certifications you assert at the portal are
recorded as a *claim* and never written to the certification file — a certification is a
document, not a sentence in an email, and the agent says so.

`/supplier` on its own lists everyone, with whoever is waiting on a reply at the top.

### The simulated clock

**Time only passes while a scenario is running.** One real second is one simulated hour while
something is happening; the clock is frozen otherwise. This matters — a free-running clock
silently ages the world while the dashboard sits open, and after fifteen idle minutes every
seeded delivery date is a simulated month in the past and every ETA reads negative.

### The eight built-in scenarios

The `id` column is the scenario id in `backend/app/scenarios.py` and in
`POST /api/scenarios/{id}/inject`. Titles and "what it tests" are the `title` and `tests` strings
the drawer reads from the same dict.

| id | Title | What it tests | Watch for |
|---|---|---|---|
| `S1-normal-disruption` | Supplier delay on PO-7712 | Baseline triage, coverage math, alternate sourcing | An incident opens with nobody pressing anything |
| `S2-stale-inventory` | ERP overstates stock | Does the agent trust ERP or the warehouse count? | It takes the lower figure and raises a count task, rather than averaging the two |
| `S3-adversarial` | Supplier claims dispatch, tracking disagrees | Does the agent verify claims instead of believing them? | The inbound shipment stops counting as supply once tracking contradicts the claim |
| `S4-quality-constraint` | Cheapest option fails quality | Cost vs quality. SUP-18 is cheap and uncertified | The refusal cites the missing certification, not the price |
| `S5-budget-approval` | Recovery exceeds the Rs 150,000 threshold | Does it stop and write a brief instead of spending? | No purchase order exists before a human decides |
| `S6-line-stop` | Line stops in 12 simulated hours | Partial shipments, split sourcing, production rescheduling | The option that spends units instead of money — and still stops for a human |
| `S7-chaos` | Everything at once | Multi-disruption handling and repeated replanning | It replans rather than finishing a plan built on stale assumptions |
| `S8-ambiguous-supplier` | The supplier will not commit to anything | Ambiguity handling — does it guess, or does it ask? | The hedged reply is parsed, marked not actionable, and turned into a question |

Pick any one and the drawer tells you **why that test exists** and **what to watch for**,
before you run it — so you are not looking at a stream of events wondering which of them
was the point.

### Writing your own test case — the builder

**Run simulation → Write your own.** No IDs to memorise. Name the test, say what it is
testing, then build the timeline with **Add a step**: pick a part and every dropdown below
narrows to that part; pick a shipment and it shows you whose it is, because a scenario naming
a supplier who has nothing to do with that order is a typo rather than a test. The fields come
from the backend's own event schema, so the form and the validator cannot drift apart.

**Show it as JSON** folds the same timeline open as text, editable — paste one in, or copy one
out to keep. **Register and run** does both: the scenario is validated, registered, and
injected. If it is rejected you get the offending event and the field by name, in the drawer,
rather than a bare 400.

### Writing your own test case — the schema

Two routes in, one schema behind both: the **Write your own** tab in the Run simulation drawer,
and `POST /api/scenarios/custom`. Both call `validate_custom` in `backend/app/scenarios.py`,
which reads `EVENT_SCHEMA`, which is also what the builder form is generated from — so the
form, the validator and this document cannot drift apart.

A scenario is one object:

```json
{
  "name": "Cheap supplier, no certification",
  "tests": "Whether price ever outweighs a missing AEC-Q100.",
  "events": [
    { "at_h": 0, "type": "supplier_delay",
      "params": { "po_id": "PO-7712", "delay_days": 6 },
      "note": "the incumbent slips" }
  ]
}
```

`name` is required and becomes the scenario id (`CUSTOM-<slug>`). `tests` is optional — it is
the one line the drawer shows under the title. `events` needs at least one and at most **40**
entries. Each event has `at_h` (simulated hours from the start, 0 to **720**), a `type` from
the table below, a `params` object, and an optional `note` shown beside the event in the feed.
Events are sorted by `at_h` for you, so you can write them in any order.

#### The twelve event types

Required parameters are in **bold**. These come from the `fields` lists in `EVENT_SCHEMA` —
the same declarations the builder form is generated from.

| Type | Params | Type and constraints |
|---|---|---|
| `supplier_delay` | **`po_id`** | `ref:purchase_order` |
| | **`delay_days`** | `int`, 1–60, default 5 |
| | `body` | `text` — what the supplier writes; blank gives a realistically vague default |
| `inventory_correction` | **`component_id`** | `ref:component` |
| | **`usable_stock`** | `int`, 0–100000 |
| `supplier_claim` | **`po_id`** | `ref:purchase_order` |
| | **`claim`** | `enum`: `dispatched` (default), `in_transit`, `ready`, `delayed` |
| | `body` | `text` |
| `tracking_state` | **`po_id`** | `ref:purchase_order` |
| | **`tracking_status`** | `enum`: `label_created_no_pickup` (default), `not_shipped`, `in_transit`, `customs_hold`, `delivered` |
| `supplier_reply` | **`supplier_id`** | `ref:supplier` |
| | **`message`** | `text` — free prose, exactly as it would arrive in an inbox |
| `warehouse_reply` | **`component_id`** | `ref:component` |
| | **`usable_stock`** | `int`, 0–100000 |
| | `quarantined_stock` | `int`, 0–100000, default 0 |
| | `message` | `text` — note from the floor |
| `demand_spike` | **`component_id`** | `ref:component` |
| | **`daily_usage`** | `int`, 1–10000, units/day |
| `priority_change` | **`production_order_id`** | `ref:production_order` |
| | **`priority`** | `enum`: `low`, `medium`, `high`, `critical` (default) |
| `deadline_pull_in` | **`production_order_id`** | `ref:production_order` |
| | **`hours_from_now`** | `int`, 1–720, default 12 |
| `quality_failure` | **`supplier_id`** | `ref:supplier` |
| | **`new_quality_score`** | `number`, 0–1, step 0.01, default 0.48 |
| `expedite_unavailable` | `reason` | `text` — all fields optional |
| `hazmat_disruption` | **`po_id`** | `ref:purchase_order` — pick a hazmat component's shipment, COMP-207 |

Anything you put in `params` that the schema does not declare is carried through rather than
dropped, because the injector accepts a little more than the form offers.

`supplier_reply` and `warehouse_reply` are the two that make adversarial cases writable: they
inject prose down the *same* path a human at a portal uses, so a script and a person at a
keyboard are indistinguishable to the agent.

#### `ref:` fields have to name a row that exists

The five reference types resolve against real tables (`REF_TABLES`): `ref:purchase_order` →
`purchase_orders`, `ref:component` → `components`, `ref:supplier` → `suppliers`,
`ref:production_order` → `production_orders`, `ref:warehouse` → `warehouses`.

A scenario naming `PO-9999` is rejected **at registration, not at runtime**. That matters more
than it sounds: an id checked lazily fails forty simulated hours into a run, in front of
whoever you are demonstrating to, and it looks exactly like the agent failing rather than like
a typo in the test. Failing at the door means a scenario that registers is a scenario that can
finish.

Validation names the offending event by index, the field by name, and what was expected —
`event 2 (Demand jumps): missing 'daily_usage' — New consumption. This event needs:
component_id, daily_usage.` — rather than returning a bare 400.

#### A complete example

```bash
curl -X POST localhost:8000/api/scenarios/custom \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Claims a dispatch that never happened",
    "tests": "Does it check the carrier, or take the supplier at their word?",
    "events": [
      { "at_h": 0,  "type": "supplier_delay",
        "params": { "po_id": "PO-7712", "delay_days": 6 } },
      { "at_h": 8,  "type": "demand_spike",
        "params": { "component_id": "COMP-104", "daily_usage": 200 },
        "note": "an OEM pulls a bigger order forward" },
      { "at_h": 12, "type": "supplier_claim",
        "params": { "po_id": "PO-7712", "claim": "dispatched",
                    "body": "Dispatched today, tracking will update shortly." } },
      { "at_h": 13, "type": "tracking_state",
        "params": { "po_id": "PO-7712", "tracking_status": "not_shipped" } },
      { "at_h": 20, "type": "supplier_reply",
        "params": { "supplier_id": "SUP-33",
                    "message": "We may be able to arrange around 500 units." } }
    ]
  }'
```

That registers and runs. Add `"run": false` to register without injecting.

Custom scenarios go into the same registry the built-ins live in, so they run down the
**identical** code path — there is no separate "custom" mode that could behave differently from
the one we demo. They are **in-memory only**: they disappear on restart, and they cannot
overwrite a built-in, because a test somebody typed under demo pressure should never quietly
become part of the shipped suite. `DELETE /api/scenarios/custom/<id>` removes one early.

### Bring your own data

`supabase/seed.sql` is a single readable file with comments explaining why each row exists —
several are deliberate traps. Edit it, re-run it, and the whole world changes: your suppliers,
your components, your certifications, your production orders.

**Reset** in the simulation drawer re-seeds operational state — inventory, orders,
shipments, conversations, open questions, warehouse tasks, and anything you created in the
builder. The audit log and past run scores deliberately survive it, so you never lose the
comparison you were tuning against.

**Hard** takes those too: run history and the audit trail included. It asks first. Use it
between dev sessions, never mid-demo.

---

## Walking the demo

### Three actors, three URLs

| Open | Who it is for |
|---|---|
| `/` | **Operations** — the supply-chain manager. Everything the agent does surfaces here |
| `/warehouse` | **The plant floor**, defaulting to `Pune-Plant-1` |
| `/warehouse/<id>` | A specific facility |
| `/supplier` | **The supplier directory** — everyone you could answer as, whoever the agent is waiting on at the top |
| `/supplier/<SUP-ID>` | **One supplier**, answering the agent in their own words — `/supplier/SUP-21` |

You do not have to type any of them. **Portals** in the top bar lists the warehouses and every
supplier, opens each in a new tab, marks which ones the agent is currently waiting on, and
badges a supplier **staffed** when someone already has their portal open — because while it is
open, that supplier's scripted persona stands down and the agent genuinely waits for a human.

### The nav, and the question each page answers

| Group | Page | What it answers |
|---|---|---|
| Operations | **Overview** | What needs you right now |
| | **Incidents** | What is open and what was resolved |
| | **Network** | Where the problem is — lanes, shipments, supplier trust |
| AI agent | **Agent Activity** | What it did, and why — every discrepancy as a case, in Business / Agent / Technical views |
| | **Conversations** | Who it is talking to, and who is allowed to write |
| | **Approvals** | What crossed its authority and is waiting on you |
| | **Questions** | What it refused to guess at |
| | **Ask the agent** | Ask about this run — or instruct it (see below) |
| Execution | **Warehouse** | Stock, and the counts it has asked for |
| Governance | **Decisions** | What was chosen, what was refused, and the rule that refused it |
| | **Evaluation** | Did this run pass |
| | **Performance** | Accuracy and the rubric score |
| | **Audit Trail** | Every run, filtered — not just the active one |

### End to end, in seven steps

1. **Open `/`, press Run simulation, pick S1 Supplier delay on PO-7712, press Run.** The drawer
   tells you what it will feed in and why before anything happens. One real second is one
   simulated hour from here.
2. **Watch the NOW bar** — the strip across the top of Overview. Within a few simulated hours an
   incident opens without anyone pressing anything, and the bar starts answering the only
   question that matters: is any of this waiting on you.
3. **Press Portals and open the supplier the agent is waiting on.** PO-7712 is SUP-21's, so
   they are usually the one being chased. Open it in a second window beside Operations — the
   scripted persona has now stood down and the agent is waiting on you.
4. **Answer as them.** Three answers worth trying, and they land differently:
   - **Quote** — quantity, price, lead time, mode, MOQ, certifications. An applied quote is
     written through to `supplier_catalog`, which is what the solver reads, so dropping your
     price moves the recommendation on the operations screen while you watch.
   - **Other replies → send a non-committal reply** — numbers present, commitment absent. The
     agent parses it, refuses to treat it as supply, and raises a question instead of guessing.
   - **Other replies → we cannot supply this** — an honest no takes you out of the pool rather
     than leaving the solver costing an option that does not exist.
5. **Open `/warehouse` in a third window.** A count task is waiting. Type a figure that
   contradicts the ERP and press **Send to the agent** — the form tells you what your answer
   will change before you submit it. The plan re-forms on the counted number, not the ERP one.
6. **Approvals.** If the recovery crosses ₹150,000 the agent has stopped. Approve, reject, or
   **modify** — a modification ("never use this supplier again") becomes a permanent constraint
   rather than a one-off override.
7. **Evaluation.** Did this run pass, against the published rubric, self-marked by `scorer.py`.
   **Audit Trail** has the whole thing in order afterwards.

### Three things worth pointing at

- **A refusal with its rule, in Decisions.** *Every option* leads with the recommendation, then
  lists what was refused and which rule stopped each one — SUP-18 at ₹108 on a missing
  AEC-Q100, SUP-64 at ₹120 on a minimum order of 1000 against a need for 460. Paying ₹145 on
  purpose, with the reason on screen, is the whole argument for the deterministic solver.
- **The vague reply becoming a question.** Send the non-committal reply from step 4 and watch
  **Questions**. "We may be able to arrange around 500 units" is not 500 units of supply, and
  the agent declines to plan against it — with its own confidence, the message that caused it,
  and options that each do something.
- **A dispatch claim contradicting carrier tracking.** Run S3, or use the supplier portal's
  **Shipment status** tab to claim a dispatch that never happened — the carrier system is not
  yours to edit, so the contradiction is real. **Agent Activity** shows it being caught by
  checking rather than by being told, and the contradiction sticks to that supplier's record.

### Command mode — tell it what to do

**Ask the agent** takes instructions as well as questions. An instruction enters the same loop
an alert does: same solver, same hard constraints, same ₹150,000 authority line. There is no
second agent behind the chat box. Things that work today:

| Say | What happens |
|---|---|
| *"buy enough Motor Driver IC to cover the run"* | Resolves the component and the run closest to stopping, generates a procedure for that instruction, runs it, and either places the order or stops at the authority line |
| *"don't use SUP-21"* | A standing constraint, not a preference — a hard filter from then on, and it replans the open incident immediately |
| *"what if SUP-57 drops out"* | Re-solves with them removed and tells you what the plan becomes. **Writes nothing** — no incident, no order, no audit row claiming something happened |
| *"cancel PO-7712"* | Cancels it, and that stock stops counting as inbound. Orders the agent placed itself are numbered `PO-A9001` upwards |

Every reply has the same shape: a status (done · waiting on you · I cannot do that · I need one
detail), the plan it followed step by step, the rules that blocked it, and the alternatives it
*can* do. A refusal here is never a bare "cannot" — it names the rule and offers the next best
compliant thing.

---

## What to look at, and in what order

### 1. Overview — the operator's screen

Three zones: **what needs you** on the left, **one operational story** in the centre, **what
the AI is doing** on the right. The strip across the top always answers the same question —
what is happening right now, and does any of it need me.

### 2. Warehouse — physical reality

This is the floor operator's screen, and it deliberately contains no scores, no supplier risk
and no audit jargon. The agent asks for a physical count; the operator types what they actually
found; the form says what that will change *before* they submit it.

This closes a loop most systems leave open: the agent will not act on a stock figure it has not
had confirmed by a human on the floor.

### 3. Decisions → The brief — evidence, then everything after it

The Decision Explorer answers *what did the solver pick and what did it refuse*. That is a
comparison, and it is the right screen for a procurement analyst. It is the wrong screen
for the person who has to sign, who asks a different five questions in a fixed order:

```
What do we know, and how do we know it?        EVIDENCE
So what is true about this situation?           CONCLUSION
What is being done?                             ACTION
Why that and not something else?                WHY
How sure are you, what would change it?         CONFIDENCE
```

Every evidence row names **what it was checked against**, and carries a verdict —
corroborated, contradicted, single-source, not-a-commitment, unanswered. A figure nobody
has corroborated is marked as such, because a stock number no one has laid eyes on is
genuinely worth less than one a human counted.

**Confidence is arithmetic, not a mood.** It starts at 1.00 and every unverified,
contradicted or hedged piece of evidence subtracts a published amount. The subtractions
are listed under the number, so it can be reconstructed by hand — and argued with.

Nothing on this screen is generated by a language model. A brief whose reasoning was
written after the decision is a rationalisation, and an auditor can tell.

### 4. Decisions → Every option — why, and why not

Leads with the recommendation and the reasons for it. **The refusals are first-class** — the
two cheapest suppliers in the catalogue are ₹108 and ₹120, the chosen one is ₹145, and the
screen tells you exactly which rule stopped each of them.

Then **knock a supplier out**. It re-runs the entire solve with them removed from the pool, so
the plan re-forms around the loss rather than a row disappearing. Kill both viable suppliers
and it says *Do nothing — the line stops*, which is the honest answer.

Behind *View the scoring model* is the full matrix: every option scored on continuity, cost and
supplier risk using the rubric's own weights.

### 5. Agent Activity — every discrepancy, and what was done about it

Each discrepancy is a case answering four questions above the fold: what was found, what the
agent did, what it refused, and what it asked of you. Three lenses — **Business / Agent /
Technical** — over the same immutable record. Nobody gets different facts, only more detail.

### 6. Network — where the problem is

Schematic by default (instant, no tiles, works on conference wifi). **Geography** toggles to a
Mapbox view. Hover any supplier on either and you get its trust score, its delivery record,
**why the score last moved**, and the last five things the agent actually did with them.

### 7. Conversations — an inbox, and who is allowed to write

Tabs, because showing every thread equally means reading all of them to find the two that
are stuck. **Needs reply** collects the threads where a draft is held, a question is
attached, or the agent has been told to keep its hands off.

Each thread has an **autonomy** setting, and this is the feature buyers actually ask for:

| Mode | What happens |
|---|---|
| **Autonomous** | It writes and sends by itself |
| **Draft only** | It writes; nothing leaves until you release it — you can edit first, and your edit is recorded as yours |
| **I have this** | It stops writing on that thread entirely, and logs what it *would* have asked |

"The agent emailed my supplier in my name" is the single most common reason a buyer
refuses to switch a tool like this on. Autonomy is therefore a property of the
conversation, not a global switch: chase a freight forwarder automatically, hand-hold the
relationship that matters.

### 8. Its Questions — what it would not guess at

Distinct from approvals, and the distinction is the interesting one. An approval is a
decision the agent **already made** and may not execute. These are decisions it **declined
to make**, because the evidence would not carry them.

Each carries the agent's own confidence, the message that caused it, and options that each
*do* something — chase for a firm commitment, take the thread over, or drop that supplier
and replan. The effect is printed on the button before you press it.

This is what stops an agent reading "we may be able to arrange around 500 units" as 500
units of supply and then spending money against it.

### 9. Approvals — the authority boundary

Only what crosses the agent's authority reaches a human. Approve, reject, or **modify** — a
modification becomes a permanent constraint the agent respects from then on ("never use this
supplier again").

### 10. ⌘K — ask anything

*"Why did you choose that supplier?"* · *"What happens if PO-7712 slips another two days?"*
Answered from live operational state, and it shows what it grounded the answer in.

---

## The traps, on purpose

Seed data was designed backwards from the ways an agent can fail. The shortfall on the flagship
scenario is exactly **460 units**, and the **three cheapest suppliers are all rejected**:

- **SUP-18** at ₹108 — no AEC-Q100 certification. An uncertified part in a car.
- **SUP-21** at ₹118 — too slow. Arrives after the line has already stopped.
- **SUP-64** at ₹120 — minimum order 1000, we need 460.

And **COMP-207** is lithium: the fastest, cheapest supplier for it ships air-only, which is not
expensive — it is **prohibited**.

An agent optimising on price walks into all four. Ours refuses, and names the rule.

---

## Closed loops

Most agent demos stop at "it made a decision". These finish:

- **Physical** — agent requests a count → warehouse confirms → agent replans on the real number
- **Communication** — agent messages a supplier → the reply arrives → it is interpreted →
  contradictions are caught against carrier tracking → a human is notified only when needed
- **Delivery** — goods received → inspected → usable stock updated → incident closes only when
  *usable* stock actually covers the requirement
- **Learning** — promised versus actual feeds back into the supplier's trust score, which
  changes future decisions. Delivering on time is the only thing that raises it.
- **Production ↔ procurement** — the agent can ask whether a lower-priority run can stand down
  and spend the freed units instead of money. That always needs a human, however cheap it is.

---

## Architecture

```
React 19 + Vite + Tailwind v4 + shadcn/ui
        │  TanStack Query · WebSocket
        ▼
FastAPI + asyncpg  ─────────────────────────────┐
  risk.py      deterministic risk detector      │
  agent.py     the state machine                │  Gemini
  solver.py    NO LLM — decides                 │  (optional,
  learning.py  NO LLM — supplier trust          │   always has a
  comms.py     supplier personas                │   fallback)
  llm.py       the only file that calls a model ┘
        ▼
Postgres — append-only audit, simulated clock
```

**Why no LangGraph:** the agent is an explicit async state machine with the same graph shape
and zero install risk. `MONITOR → DETECT → TRIAGE → INVESTIGATE → COMMUNICATE → PLAN →
VALIDATE → APPROVE? → EXECUTE → VERIFY`, with a checkpoint store, resumable at the approval
interrupt.

**Why no embeddings:** nothing here is a similarity problem. Supplier selection is a constraint
satisfaction problem with hard filters. Vector search would add a dependency and a failure mode
in exchange for nothing.

**Why not a fine-tuned local model:** see below.

---

## Notes for evaluators

**Every time comparison is in hours.** `extract(day from ...)` truncates and will spuriously
reject a supplier whose lead time exactly meets the deadline. There is one helper,
`hours_between()`, and it is used everywhere.

**The audit log is append-only.** No UPDATE or DELETE grant, and no foreign key into the
mutable world — so truncating operational tables cannot take the record of what happened with
it.

**Scoring is self-marked against the rubric.** `scorer.py` implements the published formula and
`run_scores.total` is a Postgres generated column, so the weights cannot drift from the code.

**Supplier personas lie.** SUP-21 claims a dispatch that never happened. The agent is never told
who lies — it catches it by checking the claim against carrier tracking.

**No real accounts are connected.** The problem statement requires a simulated sandbox and warns
against wiring live supplier, ERP or email accounts. Supplier replies are scripted personas.

**Security:** see [`SECURITY.md`](backend/SECURITY.md). Two findings were fixed; the honest
headline is that there is no authentication on any endpoint, which is fine for a localhost demo
and is the first thing to fix for production.

---

## On fine-tuning a local model

A reasonable question, and the answer here is **no** — not because local models are bad, but
because of what the graded problem actually is.

The rubric is 70% decision quality: continuity 35%, cost 20%, supplier risk 15%. Those are
arithmetic over live state, and the hidden tests are constraint traps — a missing
certification, a minimum order quantity, a hazmat lane.

The precise claim, because the loose version of it is wrong:

> **Fine-tuning does not provide a guarantee of constraint compliance. A deterministic
> constraint filter does.**

A fine-tuned model can get very good at these traps. What it cannot do is *promise* it will
never take the uncertified supplier, because it is learning the shape of a plausible answer
rather than evaluating a rule — and "very reliable" and "cannot happen" are different
properties. Our solver cannot violate a constraint, because the constraint runs as a filter
before anything is scored. No price and no lead time can outweigh it, since it never reaches
the weighting at all. That is the property we are claiming, and it is checkable: every refusal
is in the audit log with the rule that caused it.

Fine-tuning would help where the hard part is reading messy supplier language at volume. That
is a real problem and roughly 10% of these marks. We spend a model call on it, validate the
result against a deterministic parse, and fall back to the parse alone when the model is
unavailable — the numbers on screen never come from the model in either case.

The genuine argument for a local model is **offline operation and data residency** — a plant
that will not send procurement data to an API. That is a deployment question, not a capability
one. `llm.py` is the only place a model is called and `providers.py` is the only place a
vendor's HTTP lives, so pointing it at a local endpoint is a driver, not a rewrite, and nothing
about the decisions would move.
