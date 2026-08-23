# DisruptionOps — Live Backlog

`TASKS.md` is the original build plan. **This file is the working state**: what is
done, what is broken, what is next, and what we know about why.

Last updated: 23 Aug 2026, 06:05.

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
- [x] **`A recovery plan was produced` false negative** — it was the stamp, as
      suspected. `recovery_plans`, `approvals`, `warehouse_tasks` and
      `human_input_requests` were all inserted without `scenario_run_id`, so
      `evaluate()` counted zero of each. Same root cause as an approval existing
      while the run-scoped `/api/approvals` returned empty. All four now stamp.
- [x] **Cover reads `-0.6 days`** — below zero the line has already stopped, so
      the strip says "Out of stock now" and "have -50 usable" reads as "nothing
      left · over-committed by 50".
- [~] **SUP-42/57/64 empty catalogue / trust 0.00** — not reproducible. Checked
      against the live DB: all three have catalogue rows, and every supplier has
      a real prior (SUP-42 = 0.81). Both screenshots were taken while the DB was
      mid-reset. Nothing changed; re-open if it recurs after a clean run.

## 3. Open — asked for, not started

- [x] **Command mode** — `POST /api/agent/command` (`backend/app/command.py`).
      Human instructions enter the *same* loop an alert would: same solver, same
      hard filters, same ₹1,50,000 authority gate. One response contract —
      `status` / `plan` / `blockers` / `alternatives` / `actions_taken` — so a
      refusal always names the rule and offers what it *can* do. Verbs: source,
      exclude-and-replan, cancel. Questions are refused as commands on purpose.
- [x] **Chat acts, not just answers.** An imperative routes to `/command`, a
      question to `/ask`. Chat renders the plan, blockers, alternatives and what
      actually changed.
- [x] **Deploy fixes** — trailing-slash normalisation in `lib/api.js` (the
      `OPTIONS //api/... 400` storm), `ALLOWED_ORIGINS` env var for CORS,
      `/` and `/health` routes.

### Command mode — still to add
- [x] **Provider layer** (`backend/app/providers.py`) — Gemini / xAI / Bedrock
      behind one shape. `LLM_PROVIDER=auto` picks whichever key is present,
      preferring production, so local and deployed differ by which secret
      exists, not which code path runs. `AWS_API_KEY_BEDROCK` is read as the xAI
      credential by default; `LLM_PROVIDER=bedrock` routes the same variable to
      the Bedrock driver instead.
- [x] **`GET /api/llm/diagnose`** — tries every provider and reports what each
      one actually did. A missing key, a revoked key, a dead model name and
      blocked egress all read as "deterministic only" and have four different
      fixes.

- [x] **Alternatives are clickable** — `POST /api/agent/command {choose}` routes
      to `agent.plan_now(prefer_label=...)`, which *reorders* the solver's
      ranking rather than bypassing it. The chosen option still passes every
      hard constraint and the same authority gate, so a button here can never
      commit something the agent would have refused on its own.
- [x] **`llm.classify_intent`** — names the verb when the regexes miss. It picks
      one of four words; every consequence is still computed deterministically.
- [ ] More verbs: "what if the shipment slips two more days" (simulate without
      committing), "prioritise the Mumbai plant", "contact every supplier
      except X", "how much to eliminate the risk entirely".

- [x] **Decisions page scoped to the run** — the picker sorts the runs this test
      actually touched to the top, marks them "this run", and defaults to one of
      them instead of whichever seeded row happened to sort first.
- [ ] **Communications tabs** — `Needs reply / AI conversations / Warehouse`,
      with per-thread autonomy control (autonomous / draft-only / hands off).
      The backend (`comms.set_autonomy`) and the column both exist; no UI.
- [ ] **Network dimming** — unaffected lanes should recede when an incident is
      open, so the eye goes to the affected path.
- [ ] **Simulation transport controls** — play / pause / speed / scrub over the
      simulated clock.
- [x] **README wording on fine-tuning** — corrected to the defensible claim:
      *"Fine-tuning does not provide a guarantee of constraint compliance. A
      deterministic constraint filter does."* A tuned model can be very good at
      the traps; it cannot promise. SUBMISSION.md never mentioned it.

## 4. Hygiene before submission

- [ ] Rotate every credential in `API KEYS/APIKEYS.txt` — Supabase DB password,
      Gemini key, Mapbox token, Redis keys. They are gitignored but they are
      also in this repo's history of your machine.
- [x] SMTP confirmed unwired — no `smtplib`, no `aiosmtplib`, no reference to
      `SMTP_HOST` anywhere in `backend/app/`. The variables sit unused in `.env`.
      Every "message" is a `thread_messages` row. The problem statement mandates
      a simulated sandbox and this stays inside it.
- [x] Supabase advisors re-run after `0008` — clean. The only findings are
      INFO-level "RLS enabled, no policy", which is the *safe* posture here:
      RLS on with no policy denies anon and authenticated outright, and the
      backend connects as the service role. No ERROR, no WARN.
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
