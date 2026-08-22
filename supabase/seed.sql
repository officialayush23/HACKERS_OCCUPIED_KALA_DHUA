-- ============================================================================
-- Seed: Pune-Plant-1 automotive electronics manufacturer
-- Every row here exists to make a specific trap reachable. Do not "clean up"
-- the awkward numbers — the awkwardness IS the test data.
-- ============================================================================

-- OPERATIONAL TABLES ONLY. scenario_runs / run_scores / audit_events are
-- HISTORY and are deliberately NOT truncated here: a demo reset must not
-- destroy the run comparisons you are tuning against. The API's
-- POST /api/scenarios/reset?mode=hard clears history separately, on purpose.
truncate supplier_memory, approvals, quotes, rfqs, messages, incidents,
         shipment_tracking, purchase_orders, production_orders, inventory,
         supplier_catalog, supplier_lanes, suppliers, components, warehouses
         restart identity cascade;

-- ---------- warehouses ------------------------------------------------------

insert into warehouses (id, name, city) values
  ('Pune-Plant-1', 'Pune Plant 1 — Chakan', 'Pune'),
  ('Pune-WH-2',    'Pune Warehouse 2 — Ranjangaon', 'Pune');

-- ---------- components ------------------------------------------------------
-- required_certifications drives the cert trap; is_hazmat drives the air-freight ban.

insert into components (id, name, is_hazmat, required_certifications, baseline_unit_price) values
  ('COMP-104', 'Motor Driver IC',        false, '{AEC-Q100,ISO-9001}', 118.00),
  ('COMP-207', 'Li-ion Cell Module',     true,  '{IEC-62133,ISO-9001}', 890.00),
  ('COMP-311', 'Wiring Harness',         false, '{ISO-9001}',           64.00),
  ('COMP-402', 'Microcontroller MCU',    false, '{AEC-Q100,IATF-16949}',340.00),
  ('COMP-118', 'Connector Set',          false, '{ISO-9001}',           22.00),
  ('COMP-520', 'TFT Display Panel',      false, '{ISO-9001}',          410.00);

-- ---------- suppliers -------------------------------------------------------

insert into suppliers (id, name, email, city, country, quality_score, reliability_score, certifications) values
  ('SUP-21',  'Zhen Hua Electronics',      'supplier21@example.com',  'Shenzhen', 'China',  0.88, 0.70, '{AEC-Q100,ISO-9001}'),
  ('SUP-42',  'Western Components Ltd',    'supplier42@example.com',  'Chennai',  'India',  0.94, 0.81, '{AEC-Q100,ISO-9001,IATF-16949}'),
  ('SUP-18',  'Budget Semicon Traders',    'supplier18@example.com',  'Shenzhen', 'China',  0.71, 0.66, '{ISO-9001}'),
  ('SUP-33',  'Deccan Rapid Supply',       'supplier33@example.com',  'Pune',     'India',  0.80, 0.55, '{AEC-Q100,ISO-9001}'),
  ('SUP-57',  'Formosa Precision',         'supplier57@example.com',  'Taipei',   'Taiwan', 0.97, 0.95, '{AEC-Q100,ISO-9001,IATF-16949}'),
  ('SUP-64',  'Bharat Bulk Components',    'supplier64@example.com',  'Chennai',  'India',  0.90, 0.78, '{AEC-Q100,ISO-9001}'),
  ('SUP-71',  'AeroCell Logistics',        'supplier71@example.com',  'Singapore','Singapore',0.92,0.84, '{IEC-62133,ISO-9001}'),
  ('SUP-88',  'Konkan Energy Systems',     'supplier88@example.com',  'Mumbai',   'India',  0.89, 0.86, '{IEC-62133,ISO-9001}'),
  ('SUP-95',  'Nexus Micro (sole source)', 'supplier95@example.com',  'Penang',   'Malaysia',0.93,0.82, '{AEC-Q100,IATF-16949,ISO-9001}'),
  ('SUP-29',  'Lowcost Display Co',        'supplier29@example.com',  'Shenzhen', 'China',  0.62, 0.60, '{ISO-9001}'),
  ('SUP-77',  'Sahyadri Harness Works',    'supplier77@example.com',  'Pune',     'India',  0.91, 0.88, '{ISO-9001}'),
  ('SUP-103', 'Coastal Connectors',        'supplier103@example.com', 'Chennai',  'India',  0.85, 0.79, '{ISO-9001}');

insert into supplier_memory (supplier_id, derived_reliability)
  select id, reliability_score from suppliers;

-- ---------- lanes (multi-modal, for free) -----------------------------------

insert into supplier_lanes (supplier_id, warehouse_id, mode, transit_days, freight_cost) values
  ('SUP-21','Pune-Plant-1','SEA', 12,  8000), ('SUP-21','Pune-Plant-1','AIR',  3, 42000),
  ('SUP-42','Pune-Plant-1','ROAD', 2,  3500), ('SUP-42','Pune-Plant-1','RAIL', 3,  2200),
  ('SUP-18','Pune-Plant-1','SEA', 11,  7500), ('SUP-18','Pune-Plant-1','AIR',  3, 40000),
  ('SUP-33','Pune-Plant-1','ROAD', 1,  1200),
  ('SUP-57','Pune-Plant-1','AIR',  3, 38000), ('SUP-57','Pune-Plant-1','SEA', 10,  9000),
  ('SUP-64','Pune-Plant-1','RAIL', 3,  2600), ('SUP-64','Pune-Plant-1','ROAD', 2,  4100),
  -- SUP-71 is AIR-ONLY. For COMP-207 (hazmat) this makes it structurally illegal.
  ('SUP-71','Pune-Plant-1','AIR',  2, 51000),
  ('SUP-88','Pune-Plant-1','ROAD', 2,  6200), ('SUP-88','Pune-Plant-1','RAIL', 3,  4800),
  ('SUP-95','Pune-Plant-1','AIR',  4, 46000), ('SUP-95','Pune-Plant-1','SEA', 14, 11000),
  ('SUP-29','Pune-Plant-1','SEA', 12,  7800),
  ('SUP-77','Pune-Plant-1','ROAD', 1,  1500),
  ('SUP-103','Pune-Plant-1','RAIL',3,  2000), ('SUP-103','Pune-Plant-1','ROAD',2, 3300);

-- ---------- catalog ---------------------------------------------------------
-- COMP-104 is the star. Read the comments — each row is a designed trap.

insert into supplier_catalog
  (supplier_id, component_id, unit_price, lead_time_days, available_quantity, min_order_quantity) values
  -- incumbent: cheap and plentiful, but it is the one that will lie about dispatch
  ('SUP-21', 'COMP-104', 118.00, 7, 1000, 200),
  -- certified + reliable, but only 300 units => cannot cover 460 alone => forces the split
  ('SUP-42', 'COMP-104', 132.00, 4,  300, 150),
  -- CHEAPEST. No AEC-Q100. Must be rejected on certification, not on price.
  ('SUP-18', 'COMP-104', 108.00, 3,  800, 200),
  -- FASTEST (1-day road, local). reliability 0.55 => speed vs risk tension
  ('SUP-33', 'COMP-104', 145.00, 2,  500, 100),
  -- most reliable in the set, exactly 300 available, MOQ 300 => the split partner
  ('SUP-57', 'COMP-104', 138.00, 5,  300, 300),
  -- attractive price, but MOQ 1000 when we need 460 => hard MOQ rejection
  ('SUP-64', 'COMP-104', 120.00, 6, 1200, 1000),

  -- COMP-207 Li-ion (HAZMAT): SUP-71 is air-only => structurally illegal
  ('SUP-71', 'COMP-207', 845.00, 2,  600, 100),
  ('SUP-88', 'COMP-207', 902.00, 6,  500, 100),

  -- COMP-402 MCU: single source, priced so the recovery crosses Rs 150,000
  ('SUP-95', 'COMP-402', 340.00, 9,  900, 100),

  -- COMP-118 Connectors: many cheap sources => split-sourcing showcase
  ('SUP-103','COMP-118',  22.00, 3, 4000, 500),
  ('SUP-77', 'COMP-118',  24.50, 1, 2500, 250),
  ('SUP-42', 'COMP-118',  23.00, 2, 3000, 500),

  -- COMP-311 Harness
  ('SUP-77', 'COMP-311',  64.00, 2, 1800, 200),
  ('SUP-64', 'COMP-311',  59.00, 5, 5000, 2000),   -- MOQ trap again

  -- COMP-520 Display: cheapest has quality 0.62
  ('SUP-29', 'COMP-520', 352.00, 8, 1200, 300),
  ('SUP-57', 'COMP-520', 428.00, 6,  700, 200);

-- ---------- inventory -------------------------------------------------------
-- COMP-104: ERP says 800, only 390 usable. THIS IS SCENARIO 2.
-- Coverage on usable stock = 390 / 90 = 4.3 days.

insert into inventory (component_id, warehouse_id, erp_stock, usable_stock, daily_usage, safety_stock) values
  ('COMP-104', 'Pune-Plant-1', 800, 390,  90, 150),
  ('COMP-207', 'Pune-Plant-1', 420, 420,  40,  80),
  ('COMP-311', 'Pune-Plant-1', 950, 950, 120, 200),
  ('COMP-402', 'Pune-Plant-1', 310, 310,  55, 120),
  ('COMP-118', 'Pune-Plant-1',2400,2400, 260, 500),
  ('COMP-520', 'Pune-Plant-1', 640, 640,  70, 150);

-- ---------- production ------------------------------------------------------
-- PROD-882 is the pressure source: 700 units of COMP-104 due in 6 days.
-- Shortfall = 700 - 390 usable + 150 safety floor = 460 units.

insert into production_orders
  (id, product, required_component, units_planned, component_per_unit, deadline, priority, warehouse_id) values
  ('PROD-882','Smart Controller Unit',   'COMP-104', 700, 1, now() + interval '6 days',  'high',     'Pune-Plant-1'),
  ('PROD-883','Battery Mgmt System',     'COMP-207', 380, 1, now() + interval '9 days',  'critical', 'Pune-Plant-1'),
  ('PROD-884','Smart Controller Unit',   'COMP-118', 700, 3, now() + interval '6 days',  'high',     'Pune-Plant-1'),
  ('PROD-885','Telematics Unit',         'COMP-402', 500, 1, now() + interval '11 days', 'medium',   'Pune-Plant-1'),
  ('PROD-886','Instrument Cluster',      'COMP-520', 450, 1, now() + interval '14 days', 'low',      'Pune-Plant-1'),
  ('PROD-887','Battery Mgmt System',     'COMP-311', 380, 2, now() + interval '9 days',  'critical', 'Pune-Plant-1');

-- ---------- open purchase orders --------------------------------------------
-- PO-7712 is the one SUP-21 will delay, then lie about.

insert into purchase_orders
  (id, component_id, supplier_id, warehouse_id, quantity, unit_price, mode, expected_delivery, status) values
  ('PO-7712','COMP-104','SUP-21','Pune-Plant-1',1000,118.00,'SEA', now() + interval '3 days','in_transit'),
  ('PO-7718','COMP-207','SUP-88','Pune-Plant-1', 400,902.00,'ROAD',now() + interval '5 days','in_transit'),
  ('PO-7725','COMP-118','SUP-103','Pune-Plant-1',3000, 22.00,'RAIL',now() + interval '4 days','open');

-- Truth starts consistent. The injector is what makes it diverge.
insert into shipment_tracking (po_id, supplier_claim, tracking_status, last_movement) values
  ('PO-7712','in_transit','in_transit', now() - interval '1 day'),
  ('PO-7718','in_transit','in_transit', now() - interval '2 days'),
  ('PO-7725',null,'not_shipped', null);

-- ---------- the inbox -------------------------------------------------------
-- Deliberately vague. Parsing this is the LLM's job, not the solver's.

insert into messages (direction, supplier_id, subject, body) values
  ('inbound','SUP-21','Delay on PO-7712',
   'Due to transport issues, delivery may be delayed by 5-7 days. We are trying to resolve this and will update soon.'),
  ('inbound','SUP-88','Re: PO-7718 status',
   'Dispatch on schedule. No issues expected at our end.');

-- ============================================================================
-- Sanity check the traps are reachable.
-- Expect 460 for COMP-104 and a shortlist where SUP-18 fails certs and
-- SUP-64 fails MOQ.
-- ============================================================================
-- select po.required_component,
--        po.units_planned * po.component_per_unit - i.usable_stock + i.safety_stock as shortfall
--   from production_orders po
--   join inventory i on i.component_id = po.required_component
--  where po.id = 'PROD-882';
