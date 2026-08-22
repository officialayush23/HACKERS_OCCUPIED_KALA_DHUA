# Security posture

Written honestly. This is a hackathon build with a production-shaped architecture, and the
difference between those two things matters. Below is what is actually true today, what was
fixed, and what would have to change before this touched a real plant.

---

## Fixed

**`supplier_effective` was SECURITY DEFINER.** Recreating the view in the learning-loop
migration left it evaluating with the creator's rights, which would silently bypass row level
security for anyone querying it. Now `security_invoker = on`. The app reads it over a trusted
server-side connection and never needed those rights.

**`supplier_trust()` had a mutable `search_path`.** A function that resolves unqualified names
against a caller-controlled schema is a privilege-escalation primitive. Pinned to
`pg_catalog, public`. Nothing in the body is unqualified today; the pin keeps that true when
somebody edits it later.

Supabase's security advisor is now clean of ERROR and WARN findings.

## Reviewed and accepted

**`rls_enabled_no_policy` on twelve tables (INFO).** RLS is on and no policy exists, so
`anon` and `authenticated` read nothing — deny by default. The backend connects as a
privileged role and bypasses RLS deliberately. This is the correct posture for a
server-mediated API; it would be wrong the moment a browser talked to Postgres directly.

**One f-string in SQL** — `learning.py`, building the counter update. The interpolated value is
looked up from a fixed module-level dict *after* an explicit whitelist check that raises on
anything else, so no caller-supplied string can reach the query text. Every other query in the
codebase uses bound parameters.

**Secrets are not in the repo.** `.gitignore` covers `*.env` and `API KEYS/`, verified with
`git check-ignore`.

## Not fixed — and these are real

**There is no authentication on any endpoint.** Zero. Every route, including
`POST /api/scenarios/reset` (which re-seeds the world) and
`POST /api/production/reschedule` (which delays a customer's order), is open to anyone who can
reach the port. For the demo the API binds to localhost and that is the whole control. Before
production this needs, at minimum:

- an identity on every request, and a role check on every mutating route
- warehouse endpoints scoped to warehouse staff — a floor operator should not be able to call
  `/api/production/reschedule`
- approvals bound to the identity that granted them; `approved_by` is currently a string the
  client sends, which means the audit log records a claim rather than a fact

**CORS is `allow_methods=["*"]` with `allow_credentials=True`,** origin-restricted to localhost
by regex. Fine while the origin regex holds; sloppy if anyone widens it without narrowing the
methods.

**No rate limiting anywhere.** `/api/agent/ask` reaches an LLM on every call.

**The database password is in a plaintext file** on the developer's machine and has been used
during this build. Rotate it after the hackathon regardless of anything else here.

**No dependency audit has been run** (`pip-audit`, `npm audit`). Worth doing before anyone
calls this production-ready.

## Deliberate design choices that are also security properties

- **The audit log is append-only.** No UPDATE or DELETE grant, and no foreign key into the
  mutable world — so a `TRUNCATE ... CASCADE` of operational tables cannot take the record of
  what happened with it.
- **The agent cannot spend past its threshold**, and cannot delay another customer's order at
  all, without a human. That gate is deterministic Python, not a prompt.
- **No real supplier, ERP or email account is connected.** The problem statement requires a
  simulated sandbox and warns against wiring live accounts; supplier replies are scripted
  personas.
- **The LLM never decides anything.** It interprets messages and writes explanations. Every
  constraint check and every choice is deterministic code, so a prompt injection in a supplier
  message cannot cause a purchase.
