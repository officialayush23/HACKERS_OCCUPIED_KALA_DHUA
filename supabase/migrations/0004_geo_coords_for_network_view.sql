-- Coordinates for the network view. The schematic projects these directly; the
-- Mapbox layer uses the same numbers, so the two views can never disagree.

alter table suppliers   add column if not exists lat numeric(9,6), add column if not exists lng numeric(9,6);
alter table warehouses  add column if not exists lat numeric(9,6), add column if not exists lng numeric(9,6);

update warehouses set lat=18.7605, lng=73.8636 where id='Pune-Plant-1';
update warehouses set lat=18.7833, lng=74.2500 where id='Pune-WH-2';

update suppliers set lat=22.5431, lng=114.0579 where id='SUP-21';   -- Shenzhen
update suppliers set lat=13.0827, lng=80.2707  where id='SUP-42';   -- Chennai
update suppliers set lat=22.5431, lng=114.0579 where id='SUP-18';   -- Shenzhen
update suppliers set lat=18.5204, lng=73.8567  where id='SUP-33';   -- Pune
update suppliers set lat=25.0330, lng=121.5654 where id='SUP-57';   -- Taipei
update suppliers set lat=13.0827, lng=80.2707  where id='SUP-64';   -- Chennai
update suppliers set lat= 1.3521, lng=103.8198 where id='SUP-71';   -- Singapore
update suppliers set lat=19.0760, lng=72.8777  where id='SUP-88';   -- Mumbai
update suppliers set lat= 5.4141, lng=100.3288 where id='SUP-95';   -- Penang
update suppliers set lat=22.5431, lng=114.0579 where id='SUP-29';   -- Shenzhen
update suppliers set lat=18.5089, lng=73.8553  where id='SUP-77';   -- Pune
update suppliers set lat=13.0827, lng=80.2707  where id='SUP-103';  -- Chennai
