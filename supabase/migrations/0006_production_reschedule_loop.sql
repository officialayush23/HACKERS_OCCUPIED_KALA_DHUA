-- T9: the production <-> procurement loop.
--
-- Until now the agent had exactly one answer to a shortage: buy more. A real
-- operations agent has a second lever -- ask whether a lower-priority run can
-- wait, and spend the freed units instead of money.
--
-- `allocated_units` is what makes that honest: usable stock is a shared pool,
-- and each open run holds a claim on it. Releasing a claim is what a reschedule
-- actually does.

alter table production_orders
  add column if not exists allocated_units      integer     not null default 0,
  add column if not exists original_deadline    timestamptz,
  add column if not exists rescheduled_at       timestamptz,
  add column if not exists rescheduled_reason   text;

comment on column production_orders.allocated_units is
  'Units of usable_stock already committed to this run. Competing runs subtract '
  'this from what a shortfall calculation may count as available.';
comment on column production_orders.original_deadline is
  'Set the first time a run is rescheduled, so the delay is always measurable '
  'against the commitment we originally made to the customer.';

-- The competing run. Aftermarket spares for Shakti Auto: same component as the
-- critical Bharat EV Motors line, lower priority, and enough slack in its own
-- deadline to absorb a week's delay.
insert into production_orders
  (id, product, product_id, required_component, units_planned, component_per_unit,
   deadline, priority, warehouse_id, is_on_hold, oem_customer, allocated_units)
values
  ('PROD-888', 'Smart Controller Unit',
   (select id from products where name ilike '%Smart Controller%' limit 1),
   'COMP-104', 300, 1,
   (select deadline + interval '11 days' from production_orders where id='PROD-882'),
   'low', 'Pune-Plant-1', false, 'Shakti Auto', 300)
on conflict (id) do update
  set allocated_units = excluded.allocated_units,
      priority        = excluded.priority,
      oem_customer    = excluded.oem_customer;

-- PROD-888 now holds 300 units, so raise the pool by the same 300. The critical
-- line's *net* availability -- and therefore its 460-unit shortfall -- is
-- unchanged. Rescheduling PROD-888 is what releases the 300.
update inventory
   set usable_stock = usable_stock + 300,
       erp_stock    = erp_stock + 300
 where component_id = 'COMP-104'
   and warehouse_id = 'Pune-Plant-1'
   and usable_stock < 600;   -- idempotent: only lifts the un-adjusted seed value
