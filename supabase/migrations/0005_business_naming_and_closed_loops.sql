-- Names instead of IDs, and the tables that let a loop actually close.
--
-- Before this, the UI could only say COMP-104 and PROD-882. An operator does not
-- think in primary keys, and neither should the screen they are reading.
--
-- The rest of this migration is the machinery for loops that finish: a message
-- thread that can be replied to, a warehouse task that can be completed, a
-- recovery plan that can be approved, a goods receipt that turns a promise into
-- physical stock.

-- ===== 1. HUMAN-READABLE NAMING LAYER =========================================
create table if not exists organizations (
  id text primary key, name text not null, industry text, city text, country text
);
create table if not exists product_families (
  id text primary key, name text not null, organization_id text references organizations(id)
);
create table if not exists products (
  id text primary key, name text not null,
  family_id text references product_families(id), sku text, oem_customer text
);

alter table components add column if not exists display_name text;
alter table components add column if not exists part_number text;
alter table components add column if not exists category text;
alter table suppliers add column if not exists legal_name text;
alter table suppliers add column if not exists facility_name text;
alter table production_orders add column if not exists product_id text references products(id);
alter table production_orders add column if not exists oem_customer text;
alter table warehouses add column if not exists organization_id text references organizations(id);

create table if not exists bill_of_materials (
  product_id text not null references products(id) on delete cascade,
  component_id text not null references components(id) on delete cascade,
  quantity_per_unit int not null default 1,
  primary key (product_id, component_id)
);

-- ===== 2. COMMUNICATION =======================================================
-- NB: `messages` already exists (raw supplier inbox from 0001). This is the
-- threaded operational conversation and is deliberately a separate table.

create table if not exists message_threads (
  id bigserial primary key,
  incident_id text,
  counterparty_type text not null check (counterparty_type in
    ('supplier','warehouse','carrier','internal','customer')),
  counterparty_id text,
  counterparty_name text,
  subject text not null,
  status text not null default 'open' check (status in ('open','awaiting_reply','closed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_threads_incident on message_threads (incident_id);

create table if not exists thread_messages (
  id bigserial primary key,
  thread_id bigint not null references message_threads(id) on delete cascade,
  direction text not null check (direction in ('outbound','inbound')),
  author_type text not null check (author_type in
    ('agent','supplier','warehouse','carrier','human','customer')),
  author_name text,
  body text not null,
  delivery_state text not null default 'sent' check (delivery_state in
    ('draft','sent','delivered','replied','awaiting_response','expired','escalated')),
  is_contradiction boolean not null default false,
  sent_at timestamptz not null default now(),
  simulated_at_seconds numeric(12,2)
);
create index if not exists idx_tmsg_thread on thread_messages (thread_id, id);

-- ===== 3. WAREHOUSE OPERATIONS ================================================
create table if not exists warehouse_tasks (
  id bigserial primary key,
  facility_id text references warehouses(id),
  component_id text references components(id),
  incident_id text,
  task_type text not null check (task_type in
    ('physical_count','usable_stock_verification','quality_hold_check',
     'release_stock','receive_shipment','verify_lot','expedite_unloading')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  requested_by text not null default 'agent',
  instructions text,
  result_payload jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_wt_status on warehouse_tasks (status, priority);

create table if not exists goods_receipts (
  id bigserial primary key,
  po_id text references purchase_orders(id),
  component_id text references components(id),
  facility_id text references warehouses(id),
  quantity_received int not null,
  quantity_approved int, quantity_quarantined int,
  inspection_status text not null default 'pending'
    check (inspection_status in ('pending','passed','partial','failed')),
  received_at timestamptz not null default now(),
  inspected_at timestamptz
);

alter table inventory add column if not exists quarantined_stock int not null default 0;

-- ===== 4. INCIDENT LIFECYCLE + RECOVERY =======================================
alter table incidents add column if not exists title text;
alter table incidents add column if not exists narrative text;
alter table incidents add column if not exists confidence text;
alter table incidents add column if not exists reopen_count int not null default 0;

create table if not exists recovery_plans (
  id bigserial primary key,
  incident_id text not null,
  status text not null default 'proposed' check (status in
    ('proposed','awaiting_approval','approved','rejected','executing','executed','failed','superseded')),
  option_kind text, label text,
  total_cost numeric(14,2), score numeric(6,4),
  rationale text, requires_approval boolean not null default false,
  payload jsonb,
  created_at timestamptz not null default now(), decided_at timestamptz
);
create index if not exists idx_rp_incident on recovery_plans (incident_id, id desc);

create table if not exists agent_constraints (
  id bigserial primary key,
  incident_id text, constraint_type text not null,
  target text, value text, reason text,
  created_by text not null default 'human',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ===== 5. LOGISTICS ===========================================================
create table if not exists shipment_positions (
  id bigserial primary key,
  po_id text references purchase_orders(id) on delete cascade,
  lat numeric(9,6), lng numeric(9,6), progress numeric(4,3),
  status_note text, source text not null default 'carrier',
  recorded_at timestamptz not null default now(),
  simulated_at_seconds numeric(12,2)
);
create index if not exists idx_sp_po on shipment_positions (po_id, id desc);

grant select on organizations, product_families, products, bill_of_materials,
  message_threads, thread_messages, warehouse_tasks, goods_receipts, recovery_plans,
  agent_constraints, shipment_positions to anon, authenticated;
