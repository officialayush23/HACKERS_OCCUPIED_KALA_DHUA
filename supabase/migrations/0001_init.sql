-- ============================================================================
-- Supply Chain Disruption Control Agent — Schema
-- Project: AUTONOMOUS_CRM (ywtmxqwshajtdmpfbwiv)
-- Domain:  Automotive electronics manufacturing, Pune-Plant-1
-- Currency: INR (paise not used; whole rupees)
-- ============================================================================

-- ---------- enums ----------------------------------------------------------

create type severity_level     as enum ('low', 'medium', 'high', 'critical');
create type incident_status    as enum ('open', 'investigating', 'planning',
                                        'awaiting_approval', 'executing',
                                        'verifying', 'resolved', 'failed');
create type po_status          as enum ('open', 'in_transit', 'delayed',
                                        'delivered', 'cancelled');
create type transport_mode     as enum ('AIR', 'SEA', 'RAIL', 'ROAD');
create type order_priority     as enum ('low', 'medium', 'high', 'critical');
create type approval_status    as enum ('pending', 'approved', 'rejected', 'expired');
create type message_direction  as enum ('inbound', 'outbound');

-- ---------- master data ----------------------------------------------------

create table components (
  id                       text primary key,             -- COMP-104
  name                     text not null,
  unit                     text not null default 'pcs',
  is_hazmat                boolean not null default false,
  required_certifications  text[] not null default '{}',
  baseline_unit_price      numeric(12,2) not null,
  created_at               timestamptz not null default now()
);
comment on column components.is_hazmat is
  'Li-ion cells etc. Blocks AIR transport mode in the solver constraint filter.';

create table warehouses (
  id        text primary key,                             -- Pune-Plant-1
  name      text not null,
  city      text not null
);

create table suppliers (
  id                 text primary key,                    -- SUP-42
  name               text not null,
  email              text not null,
  city               text not null,
  country            text not null,
  quality_score      numeric(3,2) not null check (quality_score between 0 and 1),
  reliability_score  numeric(3,2) not null check (reliability_score between 0 and 1),
  certifications     text[] not null default '{}',
  created_at         timestamptz not null default now()
);

-- Supplier -> plant transport lanes. Mode is an ATTRIBUTE, not a computation:
-- this is how we satisfy "multi-modal" without building a routing engine.
create table supplier_lanes (
  supplier_id     text not null references suppliers(id) on delete cascade,
  warehouse_id    text not null references warehouses(id) on delete cascade,
  mode            transport_mode not null,
  transit_days    int not null check (transit_days > 0),
  freight_cost    numeric(12,2) not null default 0,
  primary key (supplier_id, warehouse_id, mode)
);

create table supplier_catalog (
  id                  bigserial primary key,
  supplier_id         text not null references suppliers(id) on delete cascade,
  component_id        text not null references components(id) on delete cascade,
  unit_price          numeric(12,2) not null,
  lead_time_days      int not null check (lead_time_days >= 0),
  available_quantity  int not null check (available_quantity >= 0),
  min_order_quantity  int not null default 1 check (min_order_quantity >= 1),
  unique (supplier_id, component_id)
);
create index on supplier_catalog (component_id);

-- ---------- operational state ----------------------------------------------

-- erp_stock vs usable_stock IS Scenario 2. The trap must live in the schema.
create table inventory (
  component_id   text not null references components(id) on delete cascade,
  warehouse_id   text not null references warehouses(id) on delete cascade,
  erp_stock      int not null check (erp_stock >= 0),
  usable_stock   int not null check (usable_stock >= 0),
  daily_usage    int not null check (daily_usage >= 0),
  safety_stock   int not null default 0 check (safety_stock >= 0),
  last_updated   timestamptz not null default now(),
  primary key (component_id, warehouse_id)
);

create table production_orders (
  id                    text primary key,                 -- PROD-882
  product               text not null,
  required_component    text not null references components(id),
  units_planned         int not null check (units_planned > 0),
  component_per_unit    int not null default 1 check (component_per_unit > 0),
  deadline              timestamptz not null,
  priority              order_priority not null default 'medium',
  warehouse_id          text not null references warehouses(id),
  is_on_hold            boolean not null default false
);
create index on production_orders (required_component);
create index on production_orders (deadline);

create table purchase_orders (
  id                  text primary key,                   -- PO-7712
  component_id        text not null references components(id),
  supplier_id         text not null references suppliers(id),
  warehouse_id        text not null references warehouses(id),
  quantity            int not null check (quantity > 0),
  unit_price          numeric(12,2) not null,
  total_value         numeric(14,2) generated always as (quantity * unit_price) stored,
  mode                transport_mode not null default 'ROAD',
  expected_delivery   timestamptz not null,
  status              po_status not null default 'open',
  created_by_agent    boolean not null default false,
  incident_id         text,
  created_at          timestamptz not null default now()
);
create index on purchase_orders (component_id);
create index on purchase_orders (status);

create table shipment_tracking (
  po_id            text primary key references purchase_orders(id) on delete cascade,
  supplier_claim   text,          -- what the supplier SAYS
  tracking_status  text,          -- what the carrier system shows
  last_movement    timestamptz,
  updated_at       timestamptz not null default now()
);
comment on table shipment_tracking is
  'Scenario 3: supplier_claim vs tracking_status divergence is the adversarial trap.';

-- ---------- agent workspace -------------------------------------------------

create table incidents (
  id            text primary key,                         -- INC-1001
  type          text not null,
  severity      severity_level not null default 'medium',
  status        incident_status not null default 'open',
  component_id  text references components(id),
  source_po_id  text references purchase_orders(id),
  thread_id     text not null,                            -- LangGraph thread = incident id
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz
);
create index on incidents (status);

create table messages (
  id            bigserial primary key,
  incident_id   text references incidents(id) on delete set null,
  direction     message_direction not null,
  supplier_id   text references suppliers(id),
  subject       text,
  body          text not null,
  sent_at       timestamptz not null default now()
);
create index on messages (incident_id);

create table rfqs (
  id            bigserial primary key,
  incident_id   text references incidents(id) on delete cascade,
  component_id  text not null references components(id),
  quantity      int not null check (quantity > 0),
  needed_by     timestamptz not null,
  created_at    timestamptz not null default now()
);

create table quotes (
  id                  bigserial primary key,
  rfq_id              bigint not null references rfqs(id) on delete cascade,
  supplier_id         text not null references suppliers(id),
  quantity_available  int not null,
  unit_price          numeric(12,2) not null,
  mode                transport_mode not null,
  delivery_days       int not null,
  expedite_available  boolean not null default false,
  expedite_fee        numeric(12,2) not null default 0,
  valid_until         timestamptz not null,
  created_at          timestamptz not null default now()
);
create index on quotes (rfq_id);

create table approvals (
  id              bigserial primary key,
  incident_id     text not null references incidents(id) on delete cascade,
  action          text not null,
  estimated_cost  numeric(14,2) not null,
  reason          text not null,
  brief           text not null,             -- LLM-written decision brief
  status          approval_status not null default 'pending',
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index on approvals (status);

-- Structured memory. NOT embeddings — a reliability NUMBER explains itself
-- in the audit trail; a cosine score does not.
create table supplier_memory (
  supplier_id             text primary key references suppliers(id) on delete cascade,
  promises_made           int not null default 0,
  promises_kept           int not null default 0,
  avg_delay_days          numeric(6,2) not null default 0,
  contradictions_detected int not null default 0,
  quality_failures        int not null default 0,
  derived_reliability     numeric(3,2) not null default 0.50,
  updated_at              timestamptz not null default now()
);

-- ---------- audit: append-only backbone -------------------------------------
-- One event, four representations: human trail, dev log, WebSocket push,
-- Decision Explorer. sequence is BIGSERIAL so concurrent tool calls cannot
-- collide and corrupt replay ordering.

create table audit_events (
  sequence           bigserial primary key,
  incident_id        text references incidents(id) on delete cascade,
  ts                 timestamptz not null default now(),
  actor              text not null,          -- 'solver' | 'llm' | 'tool:get_inventory' | 'human'
  event_type         text not null,          -- OPTION_REJECTED | TOOL_CALLED | REPLAN_TRIGGERED ...
  human_summary      text not null,
  technical_payload  jsonb not null default '{}'::jsonb
);
create index on audit_events (incident_id, sequence);
create index on audit_events (event_type);

-- ---------- scenario harness + self-scoring ---------------------------------

create table scenario_runs (
  id           bigserial primary key,
  scenario_id  text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create table run_scores (
  run_id       bigint primary key references scenario_runs(id) on delete cascade,
  continuity   numeric(4,3) not null default 0,   -- weight 0.35
  cost         numeric(4,3) not null default 0,   -- weight 0.20
  risk         numeric(4,3) not null default 0,   -- weight 0.15
  tool_eff     numeric(4,3) not null default 0,   -- weight 0.10
  recovery     numeric(4,3) not null default 0,   -- weight 0.10
  audit        numeric(4,3) not null default 0,   -- weight 0.10
  total        numeric(4,3) generated always as (
                 0.35*continuity + 0.20*cost + 0.15*risk
               + 0.10*tool_eff  + 0.10*recovery + 0.10*audit
               ) stored,
  computed_at  timestamptz not null default now()
);

-- ---------- config ----------------------------------------------------------

create table system_config (
  key    text primary key,
  value  jsonb not null
);

insert into system_config (key, value) values
  ('approval_threshold_inr',   '150000'::jsonb),
  ('emergency_budget_inr',     '500000'::jsonb),
  ('max_tool_calls_per_incident', '12'::jsonb),
  ('clock_seconds_per_sim_hour',  '1'::jsonb);

-- ---------- RLS -------------------------------------------------------------
-- Only the FastAPI service role writes. audit_events is INSERT-only for
-- everyone, forever: "the audit trail is immutable at the database level."

alter table components         enable row level security;
alter table warehouses         enable row level security;
alter table suppliers          enable row level security;
alter table supplier_lanes     enable row level security;
alter table supplier_catalog   enable row level security;
alter table inventory          enable row level security;
alter table production_orders  enable row level security;
alter table purchase_orders    enable row level security;
alter table shipment_tracking  enable row level security;
alter table incidents          enable row level security;
alter table messages           enable row level security;
alter table rfqs               enable row level security;
alter table quotes             enable row level security;
alter table approvals          enable row level security;
alter table supplier_memory    enable row level security;
alter table audit_events       enable row level security;
alter table scenario_runs      enable row level security;
alter table run_scores         enable row level security;
alter table system_config      enable row level security;

-- Read-only anon access for the dashboard.
do $$
declare t text;
begin
  foreach t in array array[
    'components','warehouses','suppliers','supplier_lanes','supplier_catalog',
    'inventory','production_orders','purchase_orders','shipment_tracking',
    'incidents','messages','rfqs','quotes','approvals','supplier_memory',
    'audit_events','scenario_runs','run_scores','system_config'
  ] loop
    execute format(
      'create policy %I on %I for select to anon, authenticated using (true)',
      t || '_read', t);
  end loop;
end $$;

-- Nothing anywhere grants UPDATE or DELETE on audit_events. That is the point.
revoke update, delete on audit_events from anon, authenticated;
