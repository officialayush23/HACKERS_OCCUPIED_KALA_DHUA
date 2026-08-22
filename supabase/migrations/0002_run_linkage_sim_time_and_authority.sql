-- 1. Run linkage: which run produced this event
alter table audit_events add column scenario_run_id bigint references scenario_runs(id) on delete set null;
create index on audit_events (scenario_run_id, sequence);

-- 2. Simulated time. ts stays wall-clock; this is the reproducible axis.
alter table audit_events add column simulated_at_seconds numeric(12,2);
comment on column audit_events.simulated_at_seconds is
  'Seconds of SIMULATED time since the run started. Reproducible across runs; ts is not.';

-- 3. Scenario-specific metadata without a migration per scenario
alter table incidents add column details jsonb not null default '{}'::jsonb;

-- 5. Run lifecycle
alter table scenario_runs add column status text not null default 'running'
  check (status in ('running','completed','failed','cancelled','reset'));
alter table scenario_runs add column failure_reason text;
create index on scenario_runs (status);

-- 4. Reliability authority, stated in the schema instead of implied in code.
comment on column suppliers.reliability_score is
  'SEEDED PRIOR ONLY. Never read directly by the solver.';
comment on column supplier_memory.derived_reliability is
  'AUTHORITATIVE. Learned across incidents. The solver reads effective_reliability.';

create or replace view supplier_effective as
select s.id                     as supplier_id,
       s.name,
       s.certifications,
       s.quality_score,
       s.reliability_score      as seeded_prior,
       coalesce(m.derived_reliability, s.reliability_score) as effective_reliability,
       coalesce(m.contradictions_detected, 0) as contradictions_detected,
       coalesce(m.quality_failures, 0)        as quality_failures,
       coalesce(m.avg_delay_days, 0)          as avg_delay_days
  from suppliers s
  left join supplier_memory m on m.supplier_id = s.id;

comment on view supplier_effective is
  'Single source of truth for supplier trust. Solver joins this, never suppliers directly.';

grant select on supplier_effective to anon, authenticated;
