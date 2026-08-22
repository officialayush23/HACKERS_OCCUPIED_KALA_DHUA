-- An operational reset (truncate ... cascade) was destroying the audit trail.
--
-- First attempt was ON DELETE SET NULL. That does NOT help: TRUNCATE ... CASCADE
-- truncates every referencing table outright, regardless of the ON DELETE action.
--
-- The correct fix: an append-only event log must not hold a foreign key into the
-- mutable world it describes.
alter table audit_events drop constraint audit_events_incident_id_fkey;

comment on column audit_events.incident_id is
  'Soft reference to incidents.id. Deliberately NOT a foreign key: the audit '
  'trail must survive TRUNCATE CASCADE of the operational tables.';

-- The decision record likewise outlives the incident.
alter table approvals drop constraint approvals_incident_id_fkey;
alter table approvals add constraint approvals_incident_id_fkey
  foreign key (incident_id) references incidents(id) on delete set null;
alter table approvals alter column incident_id drop not null;
