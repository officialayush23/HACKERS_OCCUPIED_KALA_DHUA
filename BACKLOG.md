# DisruptionOps — Live Backlog

`TASKS.md` is the original build plan. **This file is the working state**: what is
done, what is broken, what is next, and what we know about why.

Last updated: 23 Aug 2026, 04:30.

---

## 0. Read this first — why the UI was not updating live

Four separate causes, all now fixed, listed because the symptom was identical
every time and the diagnosis kept restarting from scratch.

**a. The query-key storm (this was the big one).** Panels used keys like
`['kpis', revision]`, where `revision` increments on every socket event. React
Query treats a changed key as a *different query*. So every agent event created
a brand-new query, each with its own `refetchInterval` of 3–5s, and `gcTime`
kept the abandoned ones alive for 30 minutes. Twenty events into a run there
were dozens of pollers hammering the same six endpoints — which is exactly what
the server log showed. Worse, the *newest* key starts with no data, so panels
flashed empty and refilled. Fixed: `revision` removed from every key; freshness
is the socket's job.

**b. Per-component polling.** 25 components each set their own
`refetchInterval`. Removed; one 12s heartbeat in `main.jsx` sits under the
socket as a fallback for a dropped connection.

**c. Invalidation scope.** `invalidateQueries` defaults to `refetchType:
'active'`, which leaves a mounted-but-not-rendered panel holding pre-run data.
You then navigate to it and see the old world — indistinguishable from "the app
is stale". Now `refetchType: 'all'`, coalesced to one sweep per 450ms burst.

**d. Endpoints that ignored the run contract.** `/api/incidents`,
`/api/approvals`, `/api/warehouse`, `/api/human-input` and the supplier portal's
threads were unscoped, so they returned rows from wiped runs. The header said
"No test run" while the page under it rendered a full incident. All scoped now.

**Not the cause, despite looking like it:** Supabase caching, Supabase Realtime
being absent, or the socket itself. The socket was always working.

---

## 1. Fixed and verified this session

- [x] `0008` migration applied — `message_threads.autonomy` was missing, which
      killed the agent mid-run and 500'd `/api/threads`
- [x] `evaluation` / `worldbuild` never imported in `main.py` → `/api/evaluation/current`
      500'd on every call
- [x] `incident_status` enum — agent wrote `"monitoring"` and `"reopened"`, neither
      is a member. Crashed at the *last* step of a successful run. `_set_status`
      now validates against a mirrored frozenset and raises a readable error
- [x] `warehouses.country` did not exist — would have 500'd `/api/context`
- [x] Agent failures now emit `AGENT_FAILED` with a traceback and mark the
      incident `failed`, instead of leaving "Still deciding" forever
- [x] `RISK_ASSESSED` carries the shortfall arithmetic, so 460 → 160 between runs
      is explained rather than silent
- [x] `message_threads.scenario_run_id` is now stamped on insert
- [x] "Waiting on you" means the same thing on both screens
- [x] Drawer layout (definite height + `min-h-0` chain), no-run gate, NowBar
      no-run state, Evaluation loading and error states
- [x] localStorage cache (`lib/persist.js`), activity bar (`BusyBar`),
      per-page `ErrorBoundary`
- [x] `PortalLauncher` — the supplier and warehouse portals are reachable
- [x] LLM model fallback chain + a real reason on the health badge
- [x] `backend/smoke.py` — hits every read endpoint, exits non-zero on any 500

---

### Also fixed since

- [x] **Questions page crash** — the agent's options are objects
      `{id, label, detail, effect}` and the page rendered them straight as React
      children. Now rendered as choice cards showing what each option *does*.
      (This was the blank page; the boundary caught it and named it.)
- [x] **"2 decisions" vs "3 needs you" vs an empty Approvals page** — not a data
      bug. The strip counted approvals *and* questions under one word. It now
      names the kind, and the Approvals empty state links to Questions.
- [x] **Negative cover / `-50 usable`** — below zero the line has already
      stopped; it now says so, and over-commitment is stated rather than shown
      as a negative quantity.
- [x] **Sonner toasts on every mutation**, wired at the `MutationCache` so no
      future write can forget one. `meta.toast` customises, `meta.silent` opts out.
- [x] **Dedicated chat page** (`Ask the agent`) — multi-turn, with the
      deterministic cards and tables under each reply.

## 2. Open — blocking a clean demo
- [ ] **`A recovery plan was produced` fails while the run passes 9/10.** The
      S2 evaluation says no plan was produced, but the Decision Log shows one.
      Either `recovery_plans.scenario_run_id` is not being stamped, or the plan
      is written after `evaluate()` runs. Check the ordering in `injector._run`.
- [ ] **Cover reads `-0.6 days`.** Negative cover should render as "already
      out" — a negative day count is arithmetic leaking into the UI.
- [ ] **SUP-42/57/64 have no `supplier_catalog` rows**, so their portal Quote
      tab is empty and the only way to answer is freeform. Either seed catalog
      entries for the alternates or make the Quote form work off a blank slate.
- [ ] **Trust shows 0.00 for suppliers with no history.** Laplace smoothing
      should floor at the seeded prior, not zero.

## 3. Open — asked for, not started

- [ ] **Chatbot.** A real conversation with the agent, not one-shot Q&A: message
      history, follow-ups, and the deterministic `blocks` (cards/tables) already
      returned by `/api/agent/ask` rendered per turn. Should live as a panel, not
      only inside the command bar.
- [ ] **Decisions page scoped to the run.** The production-order picker lists
      every order in the world with no indication which belong to this run or
      which suppliers the scenario actually seeded. This is the single most
      confusing screen for a judge.
- [ ] **Communications tabs** — `Needs reply / AI conversations / Warehouse`,
      with per-thread autonomy control (autonomous / draft-only / hands off).
      The backend (`comms.set_autonomy`) and the column both exist; no UI.
- [ ] **Network dimming** — unaffected lanes should recede when an incident is
      open, so the eye goes to the affected path.
- [ ] **Simulation transport controls** — play / pause / speed / scrub over the
      simulated clock.
- [ ] **README + SUBMISSION wording on fine-tuning.** Current text overclaims.
      Correct framing: *"Fine-tuning does not provide a guarantee of constraint
      compliance. A deterministic constraint filter does."*

## 4. Hygiene before submission

- [ ] Rotate every credential in `API KEYS/APIKEYS.txt` — Supabase DB password,
      Gemini key, Mapbox token, Redis keys. They are gitignored but they are
      also in this repo's history of your machine.
- [ ] Confirm SMTP stays unwired. The problem statement mandates a simulated
      sandbox; connecting a real mail account would fail the brief.
- [ ] Re-run `get_advisors` on Supabase after the `0008` migration.
- [ ] `python backend/smoke.py` green before every demo.

---

## 5. Standing constraints

- Gemini for testing. **Bedrock stays unimplemented** until explicitly asked.
- **Never `git push`.** Stage only; Ayush pushes.
- `audit_events` stays append-only — no UPDATE/DELETE grant, no FK into the
  mutable world.
- One push channel (the WebSocket). No Supabase Realtime — two push paths
  eventually disagree, and disagreement is the failure mode this dashboard
  cannot afford.
