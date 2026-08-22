-- T10: the supplier learning loop.
--
-- Trust was a one-way ratchet: contradictions and quality failures each
-- subtracted a fixed amount, and nothing ever earned it back. A supplier late
-- once stayed punished forever; one who quietly delivered forty times on
-- schedule accumulated no credit. Within a quarter the number is useless.
--
-- Now it is a ratio -- what a supplier promised against what they actually did,
-- smoothed toward their seeded prior so one early data point cannot swing it,
-- minus penalties for the things that are worse than lateness: lying about a
-- dispatch, and shipping parts that fail inspection.

alter table supplier_memory
  add column if not exists deliveries_on_time  integer not null default 0,
  add column if not exists deliveries_late     integer not null default 0,
  add column if not exists units_delivered     integer not null default 0,
  add column if not exists units_rejected      integer not null default 0,
  add column if not exists last_event          text,
  add column if not exists last_event_at       timestamptz;

-- Every movement in a supplier's trust score, with the reason. Without this the
-- number is an opinion; with it, it is an argument you can check.
create table if not exists reliability_events (
  id            bigserial primary key,
  supplier_id   text not null,
  incident_id   text,
  event         text not null,   -- delivered_on_time | delivered_late |
                                 -- contradiction | quality_failure | promise_made
  before_score  numeric(4,3),
  after_score   numeric(4,3),
  delta         numeric(4,3),
  reason        text not null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_rel_events_supplier
  on reliability_events (supplier_id, id desc);

grant select on reliability_events to anon, authenticated;

-- One definition of trust, in the database, so Python can never drift from it.
create or replace function supplier_trust(
  p_prior            numeric,
  p_on_time          integer,
  p_late             integer,
  p_contradictions   integer,
  p_quality_failures integer,
  p_avg_delay_days   numeric
) returns numeric
language sql immutable as $$
  select greatest(0.05, least(0.99,
      (coalesce(p_on_time,0) + 2 * coalesce(p_prior, 0.7))
    / nullif(coalesce(p_on_time,0) + coalesce(p_late,0) + 2, 0)
    - 0.20 * coalesce(p_contradictions,0)
    - 0.10 * coalesce(p_quality_failures,0)
    - 0.02 * coalesce(p_avg_delay_days,0)
  ))::numeric(4,3);
$$;

comment on function supplier_trust is
  'Deterministic supplier trust. The solver reads it through supplier_effective; '
  'reliability_events explains every movement in it.';

-- The view's column types are part of its contract, so rebuild rather than
-- replace in place.
drop view if exists supplier_effective;

create view supplier_effective as
select s.id                     as supplier_id,
       s.name,
       s.certifications,
       s.quality_score,
       s.reliability_score      as seeded_prior,
       case when m.supplier_id is null then s.reliability_score::numeric(4,3)
            else supplier_trust(s.reliability_score,
                                m.deliveries_on_time, m.deliveries_late,
                                m.contradictions_detected, m.quality_failures,
                                m.avg_delay_days)
       end                                    as effective_reliability,
       coalesce(m.contradictions_detected, 0) as contradictions_detected,
       coalesce(m.quality_failures, 0)        as quality_failures,
       coalesce(m.avg_delay_days, 0)          as avg_delay_days,
       coalesce(m.deliveries_on_time, 0)      as deliveries_on_time,
       coalesce(m.deliveries_late, 0)         as deliveries_late,
       coalesce(m.units_delivered, 0)         as units_delivered,
       coalesce(m.units_rejected, 0)          as units_rejected,
       m.last_event, m.last_event_at
  from suppliers s
  left join supplier_memory m on m.supplier_id = s.id;

comment on view supplier_effective is
  'Single source of truth for supplier trust. Solver joins this, never suppliers directly.';

grant select on supplier_effective to anon, authenticated;
