# What we built, and why

## The problem

A factory doesn't stop because it ran out of everything. It stops because it ran out of **one part**.

Pune-Plant-1 builds Smart Controller Units for EV two-wheelers. Each needs one COMP-104 motor
driver IC. There are 390 usable in the warehouse; the line consumes 90/day. **4.3 days of runway.**
A shipment of 1000 is in transit, due in 3 days. Everything is fine.

Then the supplier emails:

> *"Due to transport issues, delivery may be delayed by 5-7 days."*

A human now has to answer, fast:

- How bad is this really? (depends on **real** stock, not ERP stock)
- Which alternate suppliers can cover it?
- Which are we *allowed* to buy from?
- Can I approve this, or does it need my director?
- And when the supplier says "don't worry, it shipped" — do I believe them?

Hours of work. Times dozens of components. That is what we automated.

---

## What the system is

Three separable pieces. Be able to name them individually.

### 1. A simulated factory
Real Supabase Postgres. 6 components, 12 suppliers (Shenzhen, Taipei, Chennai, Mumbai, Pune,
Singapore, Penang), 6 production runs, purchase orders, carrier tracking, supplier inbox.
Live rows, not page fixtures.

### 2. An adversary
The **scenario injector**. Fires timed disruptions at that database — delays, ERP corrections,
supplier lies, demand spikes, deadline pull-ins, hazmat failures. Built *before* the agent,
on purpose: you cannot test recovery you cannot trigger.

### 3. The agent
Watches, investigates, decides, explains — writing an immutable record of everything.

---

## The one decision everything hangs on

The rubric: continuity 35%, cost 20%, supplier risk 15%. **70% of the score is decision quality
measured as numbers.** Every hidden test is a constraint trap.

So the agent is split in two:

| Job | Who | Why |
|---|---|---|
| Parse a vague email, spot a contradiction, judge ambiguity | **LLM** | Language is what it's good at |
| Pick the supplier, enforce rules, do arithmetic | **Deterministic Python** | It cannot violate a constraint |
| Write the audit trail and approval brief | **LLM** | Explanation is what it's good at |

An LLM comparing six quotes against certification, MOQ, lead time, budget and safety stock, over
changing state, live on stage, **will** eventually break one. Not from stupidity — from doing
arithmetic in prose.

A filter can't. `if 'AEC-Q100' not in supplier.certifications: reject()` has no bad day.

---

## One run, end to end

SUP-21 delays PO-7712 by 5 days.

### Step 1 — compute the real shortfall
Not from ERP. ERP says 800 and it is wrong.

```
700 needed  −  390 usable  +  150 safety floor  =  460 units short
```

### Step 2 — enumerate everything
All 6 suppliers carrying COMP-104, every 2-supplier split, "do nothing", "reschedule production".

### Step 3 — filter on hard constraints
Sorted by price, which is the point:

| Supplier | ₹/unit | Verdict |
|---|---:|---|
| SUP-18 | **108** | REJECT — no AEC-Q100 certification |
| SUP-21 | 118 | REJECT — 7-day lead, too slow |
| SUP-64 | **120** | REJECT — MOQ 1000, we need 460 |
| SUP-42 | 132 | partial — certified, only 300 available |
| SUP-57 | 138 | partial — most reliable, only 300, MOQ 300 |
| SUP-33 | **145** | ELIGIBLE |

**The three cheapest are all rejected.** A price-sorting system hits a wall three times, then buys
an uncertified chip for a car. Every rejection is recorded *with the rule that caused it* — which is
the constraint proof, the audit trail, and the UI, all from one row.

Hard constraints: certification · MOQ · hazmat · budget.
Lateness is **not** hard — it's scored with a priority-weighted penalty, because a partial shipment
36 hours late beats a stopped line.

### Step 4 — score survivors on the judges' weights
`0.35·continuity + 0.20·cost + 0.15·risk`. The split wins.

---

## The two other traps

### The liar
SUP-21 later claims "dispatched". Carrier tracking says `label_created_no_pickup` — a label was
printed, nobody collected it. The agent cross-checks instead of believing, records the
contradiction, and **drops that supplier's trust score by 0.25 permanently**. It persists across
incidents: next time SUP-21 quotes, it is already distrusted.

### The illegal option
COMP-207 is a Li-ion cell module. Its best supplier on paper — cheapest, 2-day lead — ships
air-only. Lithium cells cannot fly. That option is not expensive, it is **prohibited**.

---

## Architecture

```
React + shadcn ──REST──▶ FastAPI ──▶ solver ──▶ Supabase Postgres
      ▲                     │                   (ERP · audit · memory)
      └───── WebSocket ─────┘
```

- **One database.** Supabase is the source of truth.
- **One broadcast path.** FastAPI owns the WebSocket. No Redis pub/sub, no Supabase Realtime.
- **One writer.** Only FastAPI writes. `audit_events` is append-only — no UPDATE or DELETE grant
  exists anywhere, and it holds no foreign key into the mutable world, so a reset cannot erase it.
- **One event, four views.** Each `audit_events` row carries `human_summary` and
  `technical_payload`; the timeline, the dev log, the WebSocket push and the Decision Explorer all
  render the same row. There is no separate human log.

`run_scores.total` is a **generated column** computing the rubric formula inside Postgres, so the
weights cannot drift between the scorer and the database.

---

## What each screen is for

| Screen | Answers |
|---|---|
| **Overview** | Is anything on fire, and how long until the line stops? |
| **Supply Network** | Where is the disruption, and which lanes are still healthy? |
| **Decision Explorer** | What was chosen, what was refused, and under which rule? |
| **Audit Trail** | Exactly what happened, in sequence, with simulated timestamps |
| **Self-Scoring** | How do we do against the judges' own formula? |

---

## Design choices worth defending

**No map tiles.** Equirectangular projection over an Asia bounding box. Real relative geography,
no API key, no billing, nothing to fail on conference wifi.

**No embeddings.** Supplier trust is a number produced by counting kept promises and caught
contradictions. A reliability *score* explains itself in an audit trail; a cosine similarity does not.

**Simulated clock.** 1 real second = 1 simulated hour, so a five-day delay plays out in two minutes.
All comparisons are in hours — truncating to days spuriously rejects a supplier whose lead time
exactly meets the deadline.

**Built the adversary first.** The judges will inject hidden disruptions. We inject our own.

---

## The closing line

> Traditional ERP tells you a shipment is late. It doesn't tell you the line stops Thursday, that the
> cheap supplier is uncertified, that the incumbent is lying, or that air freight is illegal for this
> part. We made the reasoning explicit and auditable — **the model explains, the code decides.**
