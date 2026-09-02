-- Explicit hosts per team event type.
--
-- Until now a team-owned event type's hosts were "every current member",
-- each on their default schedule. This table lets an admin pick a subset,
-- mark collective hosts required or optional, give a host a per-event
-- schedule and a per-event round-robin weight. No rows = the old behaviour,
-- so existing event types need no backfill. Additive, forward-only
-- (ADR-0006 §4).
--
-- Both references are guarded at write time inside the INSERT itself
-- (repositories.ts): user_id must be a member of the owning team and
-- schedule_id must belong to that user, resolved through scalar subqueries
-- into NOT NULL columns so a stale or crafted write fails the statement
-- rather than storing a dangling reference.

CREATE TABLE IF NOT EXISTS event_type_hosts (
  event_type_id TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  required      INTEGER NOT NULL DEFAULT 1,
  schedule_id   TEXT,
  rr_weight     INTEGER,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_type_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_type_hosts_user_idx ON event_type_hosts (user_id);
