-- Three things that were asserted rather than testable, made testable.
--
-- 1. A SUPPLIER is now an actor with a screen, not a timer with a script. Until
--    now the adversarial beat — "the supplier lies and the agent catches it" —
--    was a persona firing a hardcoded string. A judge could not disagree with
--    it. Now a human can sit at /supplier/SUP-21, quote a real price, hedge,
--    decline, or claim a dispatch that never happened, and the agent has to
--    cope with a counterparty it cannot predict.
--
-- 2. A THREAD now has an autonomy setting. "The agent emails my supplier in my
--    name" is the single most common reason a buyer refuses to switch this kind
--    of tool on. Per thread: act on its own, draft and wait, or hands off.
--
-- 3. HUMAN_INPUT_REQUIRED was already being emitted with a confidence and a
--    list of options, and nothing rendered it — so the agent was politely
--    asking a question into a log file. It is a row now, with a status, so the
--    question can actually be answered and the answer can actually do something.

-- ===== 1. THREAD AUTONOMY =====================================================

alter table message_threads add column if not exists autonomy text not null default 'autonomous';
do $$
begin
  alter table message_threads add constraint message_threads_autonomy_chk
    check (autonomy in ('autonomous', 'draft', 'human'));
exception when duplicate_object then null;
end $$;

comment on column message_threads.autonomy is
  'autonomous = the agent sends by itself · draft = it writes and waits for a '
  'human to press send · human = the agent stops writing here entirely.';

alter table message_threads add column if not exists last_activity_at timestamptz not null default now();
alter table message_threads add column if not exists needs_reply boolean not null default false;

-- ===== 2. SUPPLIER QUOTES =====================================================
-- A structured offer, whoever it came from. `quotes` (0001) hangs off an rfq
-- row and was never wired up; this hangs off a conversation, which is where
-- offers actually arrive.

create table if not exists supplier_quotes (
  id                  bigserial primary key,
  thread_id           bigint references message_threads(id) on delete set null,
  incident_id         text,
  supplier_id         text not null references suppliers(id) on delete cascade,
  component_id        text references components(id) on delete set null,
  quantity_offered    int,
  unit_price          numeric(12,2),
  lead_time_days      int,
  mode                transport_mode,
  min_order_quantity  int,
  certifications      text[] not null default '{}',
  expedite_available  boolean not null default false,
  expedite_fee        numeric(12,2) not null default 0,
  note                text,
  -- portal  : a human typed it at /supplier/<id>
  -- persona : the scripted counterparty answered on the simulated clock
  -- event   : a scenario injected it
  source              text not null default 'portal'
                      check (source in ('portal', 'persona', 'event')),
  status              text not null default 'offered'
                      check (status in ('offered', 'applied', 'declined', 'expired', 'superseded')),
  applied_to_catalog  boolean not null default false,
  created_at          timestamptz not null default now(),
  simulated_at_seconds numeric(12,2)
);
create index if not exists idx_sq_supplier on supplier_quotes (supplier_id, id desc);
create index if not exists idx_sq_component on supplier_quotes (component_id, id desc);

comment on table supplier_quotes is
  'An offer is only real if it can change the plan. An applied quote is written '
  'through to supplier_catalog, which is what the solver reads — so a supplier '
  'who drops their price at the portal moves the recommendation on screen.';

-- ===== 3. HUMAN INPUT QUEUE ===================================================

create table if not exists human_input_requests (
  id            bigserial primary key,
  incident_id   text,
  thread_id     bigint references message_threads(id) on delete set null,
  supplier_id   text,
  component_id  text,
  -- ambiguous_reply | contradiction | no_viable_option | conflicting_extraction
  kind          text not null,
  question      text not null,
  detail        text,
  context       jsonb not null default '{}'::jsonb,
  -- [{id, label, detail, effect}] — every option says what it will DO
  options       jsonb not null default '[]'::jsonb,
  confidence    numeric(4,3),
  status        text not null default 'open'
                check (status in ('open', 'resolved', 'expired', 'withdrawn')),
  chosen_option text,
  note          text,
  resolved_by   text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  simulated_at_seconds numeric(12,2)
);
create index if not exists idx_hir_open on human_input_requests (status, id desc);

comment on table human_input_requests is
  'The agent asking a question it is not entitled to answer. Distinct from '
  'approvals: an approval is a decision it already made and may not execute; '
  'this is a decision it declined to make because the evidence would not carry it.';

-- ===== 4. TEST ENTITIES =======================================================
-- A judge should be able to build their own trap — "the cheapest supplier has
-- no AEC-Q100" — without editing our seed file. Entities they create are
-- flagged, so the UI can say which parts of the world are theirs, and a reset
-- takes them away with everything else.

alter table suppliers  add column if not exists origin text not null default 'seed';
alter table components add column if not exists origin text not null default 'seed';

comment on column suppliers.origin is
  'seed | test — a supplier created from the scenario builder is test, and does '
  'not survive a reset.';

grant select on supplier_quotes, human_input_requests to anon, authenticated;
