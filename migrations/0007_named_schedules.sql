-- Per-event-type availability schedules (CCC-581).
--
-- Forward-only and additive (ADR-0006 §4): `availability_schedules` (one row
-- per user, PK = user_id) cannot become one-row-per-schedule in place —
-- SQLite/D1 cannot ALTER a table's PRIMARY KEY, and every migration in this
-- repo before this one has been add-only. Instead: a NEW `schedules` table,
-- backfilled from the old one, plus a nullable `event_types.schedule_id`.
-- `availability_schedules` is left fully intact and unread by any
-- repository — dropping it is a separate future cleanup migration, once the
-- new table has been live long enough to trust, not part of this one.

CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  timezone      TEXT NOT NULL,
  weekly_json   TEXT NOT NULL,
  overrides_json TEXT NOT NULL DEFAULT '[]',
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS schedules_user_idx ON schedules(user_id);

-- "At most one DEFAULT per user," not "at most one schedule per user" — a
-- plain unique index on user_id would defeat the whole feature.
CREATE UNIQUE INDEX IF NOT EXISTS schedules_user_default_idx
  ON schedules(user_id) WHERE is_default = 1;

-- Every existing user's single schedule becomes their "Working hours"
-- default. Deterministic id (not the app's usual random `sch_` + token) so
-- this backfill needs no runtime randomness and can never collide — user_id
-- is already unique in the source table.
INSERT INTO schedules (id, user_id, name, is_default, timezone, weekly_json, overrides_json, updated_at)
SELECT 'sch_default_' || user_id, user_id, 'Working hours', 1, timezone, weekly_json, overrides_json, updated_at
FROM availability_schedules;

-- Null = the owner's default schedule — today's exact behavior, so every
-- existing event type reads correctly with no backfill needed here.
ALTER TABLE event_types ADD COLUMN schedule_id TEXT;
