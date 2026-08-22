# What this is, and what to say

## The one-liner

> "An AI agent that detects supply-chain disruptions, **verifies supplier claims against carrier data**,
> and produces a recovery plan that provably cannot violate a business constraint —
> because the decision is made by deterministic code, not by a language model."

---

## What is actually happening (the honest version)

We simulate a real factory: **Pune-Plant-1**, a tier-1 automotive electronics maker.
6 components, 12 suppliers across Shenzhen / Taipei / Chennai / Mumbai / Pune, 6 production runs.
All of it lives in **Supabase Postgres**. Nothing on screen is mocked.

Then we attack it. The **scenario injector** fires timed disruptions at the database — a supplier
delays a shipment, ERP stock turns out to be wrong, a supplier lies about dispatch. Every mutation
writes an **immutable audit event**, which streams to the dashboard over a WebSocket.

When a disruption lands, the **solver** computes the recovery. It is plain Python — no LLM — and it
records not just what it chose but **every option it rejected and the exact constraint that killed it**.

---

## How to seed the database (run once)

Supabase → SQL Editor → paste and run, in this order:

| # | File | What it does |
|---|---|---|
| 1 | `supabase/migrations/0001_init.sql` | 19 tables, enums, RLS, append-only audit trail |
| 2 | `supabase/migrations/0002_run_linkage_sim_time_and_authority.sql` | Run IDs on events, simulated time, `supplier_effective` view |
| 3 | `supabase/migrations/0003_audit_log_survives_reset.sql` | Stops a reset from wiping history |
| 4 | `supabase/seed.sql` | The 12 suppliers, 6 components, the traps, the map coordinates |

**Only `seed.sql` is ever re-run.** The migrations are one-time. After that, the **Reset** button in
the dashboard re-runs `seed.sql` for you in under a second — that is how you get back to a clean
world between demos.

- **Reset** = fresh world, run history **kept** (so you can compare runs)
- **Hard** = also wipes history. Only between dev sessions.

---

## The 5-minute demo, beat by beat

### 0:00 — Overview. "This is a live factory, not a mockup."

Point at the sidebar footer: *"Live — real backend. Every number here is a Postgres read."*

Point at **MIN COVERAGE 4.3d**. Say:

> "That's how many days of production we have left on our motor driver IC before the line stops.
> 390 usable units, 90 a day."

Point at **410u ERP gap**. Say:

> "And here's the first problem. ERP says we have 800. The warehouse actually has 390.
> The agent has to know which number to trust."

### 1:00 — Inject S3. "Now we attack it."

Click **Supplier claims dispatch, tracking disagrees**.

Watch the timeline. Three events arrive in sequence, each stamped with simulated time:

```
T+0.0h   disruption      SUP-21 delayed PO-7712 by ~5 days
T+10.1h  claim           SUP-21 claims PO-7712 is 'dispatched'
T+11.4h  contradiction   CONTRADICTION: supplier claims 'dispatched',
                         carrier shows 'label_created_no_pickup'
```

Say:

> "The supplier told us it shipped. The carrier system says a label was printed and nobody ever
> picked it up. The agent caught the lie — and it did not take the supplier's word for it,
> it went and checked."

Point at **LIES CAUGHT: 2** in the KPI strip. Then the Supply Network — the Shenzhen lane is red
and pulsing, with the contradiction called out.

### 2:30 — Decision Explorer. **This is the money screen.**

Click **Decision Explorer**. Pick the production run at the top — it opens on the one in the
most trouble. Every option the solver costed is a column; every criterion is a row. The chosen
column is the lit one.

Point at *"Considered and refused"*:

```
SUP-18  certification   Budget Semicon Traders lacks AEC-Q100.
SUP-64  MOQ             Bharat Bulk requires a minimum order of 1000, we need 460.
```

Say — and this is the sentence that wins the round:

> "The two cheapest suppliers in our catalogue are ₹108 and ₹120. The one we picked is ₹145.
> A system that optimises on price walks straight into an uncertified part going into a car,
> or a forced 1000-unit buy. **Ours refuses, and it tells you exactly which rule stopped it.**
> That's not the model being clever. That's deterministic Python. It cannot violate a constraint,
> because the constraint is a filter, not a prompt."

### 3:10 — The what-if. "What happens when the plan we just made falls apart?"

Still on the Decision Explorer. Click the supplier chip marked **in plan**.

> "I have just told the system that supplier no longer exists. Watch — it does not grey out a
> row. It re-runs the whole solve with them removed from the pool, and the plan re-forms."

The banner names the new plan and the extra cost. Then kill the second viable supplier too:

> "Now there is no recovery. It says so. It does not invent one — it tells me the line stops.
> An agent that cannot say *I have nothing* is an agent you cannot trust when it says *I have this*."

Nothing in the what-if is recorded. Say that out loud — it is a sandbox, and the audit log stays
a record of what actually happened.

### 3:20 — The second lever. "Every other agent here can only spend money."

Still on the Decision Explorer. Point at the top row of the matrix — the winning option is not a
purchase order.

> "The cheapest way to buy our way out of this is ₹86,700. The agent's answer is ₹43,200, and the
> difference isn't a better supplier. It found that a low-priority aftermarket batch for Shakti
> Auto — not due for another two weeks — is sitting on 300 of the units we need. So it asks for
> those back and buys only the remaining 160."

Then point at the **"Who else pays"** row:

> "It also tells you who absorbs that, in the only currency that matters here: Shakti Auto waits
> eleven more days. And look — this is the cheapest option on the board, and it *still* stops for
> approval. Not because of the money. Because delaying somebody else's order is not a decision an
> agent gets to make on its own."

That is the difference between a purchasing bot and an operations agent.

### 3:30 — Hazmat. "Some options aren't expensive. They're illegal."

Switch component to COMP-207 (Li-ion). Say:

> "The best supplier on paper — cheapest, two-day lead — only ships by air.
> These are lithium cells. Air freight is prohibited. Not costly. Prohibited.
> The agent rejects it on a regulation, and says so in the audit trail."

### 4:15 — Self-Scoring. "We scored ourselves against your rubric."

Click **Self-Scoring**.

> "This implements your published formula — 35% continuity, 20% cost, 15% supplier risk,
> 10% tool efficiency, 10% recovery, 10% audit. We run every scenario through it.
> The total is a generated column in Postgres so the weights can't drift.
> We've been optimising against your rubric, not guessing at it."

### 4:45 — Close

> "The split we settled on: the LLM investigates, interprets vague supplier emails, and explains
> itself in English. Deterministic code decides and enforces. That's the only split where you can
> actually put an agent in front of a purchase order and sleep at night."

---

## If a judge asks…

**"Is this using an LLM at all?"**
> "Not in the decision path, deliberately. The solver is pure Python and unit-tested. The LLM's job
> is parsing vague supplier messages and writing the audit narrative. Next milestone is the LangGraph
> loop for investigation and replanning — the deterministic core underneath it is already done and tested."

**"What if the data is fake?"**
> "The simulation is ours, the database is real Supabase. Every number on that screen is a live query.
> Here's the seed file — every awkward number in it exists to make a specific failure reachable."

**"Why no map tiles?"**
> "Equirectangular projection over an Asia bounding box. Real relative geography, no API key,
> no billing, nothing to fail on a conference wifi."

**"How do you know it's correct?"**
> "We built the adversary before the agent, and a self-scorer that implements your rubric.
> We can replay any run — every event carries its run ID and simulated timestamp."

---

## Known gaps — say these before a judge finds them

- Supplier replies are scripted personas, not a real inbox. The problem statement asks for a
  simulated sandbox and warns against wiring real supplier or ERP accounts — so we did not.
- Shipments do not yet animate along their route on the map; position is a static ETA.
- The supplier learning loop (promised vs actual reliability feeding back into scoring) is
  designed and specced, not built.

Being straight about this reads far better than being caught.
