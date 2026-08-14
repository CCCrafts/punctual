-- Punctual initial schema (spec §9, ADR-0002, ADR-0005).
--
-- Forward-only and additive (ADR-0006 §4): self-hosters upgrade on their own
-- schedule and will skip versions, so no migration may assume the previous
-- release ran recently, and none may require a manual step to succeed.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  tz          TEXT NOT NULL DEFAULT 'UTC',
  slug        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_slug_idx  ON users (slug);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_slug_idx ON teams (slug);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  rr_weight  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id);

CREATE TABLE IF NOT EXISTS event_types (
  id                     TEXT PRIMARY KEY,
  owner_user_id          TEXT,
  owner_team_id          TEXT,
  scheduling_type        TEXT NOT NULL DEFAULT 'personal',
  slug                   TEXT NOT NULL,
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  duration_minutes       INTEGER NOT NULL,
  slot_interval_minutes  INTEGER,
  buffer_before_minutes  INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes   INTEGER NOT NULL DEFAULT 0,
  min_notice_minutes     INTEGER NOT NULL DEFAULT 0,
  max_horizon_days       INTEGER NOT NULL DEFAULT 60,
  max_per_day            INTEGER,
  location_type          TEXT NOT NULL DEFAULT 'google_meet',
  location_value         TEXT,
  questions_json         TEXT NOT NULL DEFAULT '[]',
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS event_types_owner_user_idx ON event_types (owner_user_id);
CREATE INDEX IF NOT EXISTS event_types_owner_team_idx ON event_types (owner_team_id);
-- A slug is unique per owner, not globally: two hosts may both have /30min.
CREATE UNIQUE INDEX IF NOT EXISTS event_types_user_slug_idx ON event_types (owner_user_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS event_types_team_slug_idx ON event_types (owner_team_id, slug);

CREATE TABLE IF NOT EXISTS availability_schedules (
  user_id        TEXT PRIMARY KEY,
  timezone       TEXT NOT NULL,
  weekly_json    TEXT NOT NULL,
  overrides_json TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_connections (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  provider               TEXT NOT NULL,
  provider_account_email TEXT NOT NULL DEFAULT '',
  encrypted_tokens       TEXT NOT NULL,
  -- Present from day one so keys rotate without downtime (ADR-0005 §6).
  key_version            INTEGER NOT NULL DEFAULT 1,
  calendar_ids_read_json TEXT NOT NULL DEFAULT '[]',
  calendar_id_write      TEXT,
  sync_status            TEXT NOT NULL DEFAULT 'ok',
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_connections_user_idx ON calendar_connections (user_id);

CREATE TABLE IF NOT EXISTS bookings (
  id                       TEXT PRIMARY KEY,
  event_type_id            TEXT NOT NULL,
  host_user_id             TEXT NOT NULL,
  host_user_ids_json       TEXT NOT NULL DEFAULT '[]',
  guest_name               TEXT NOT NULL,
  guest_email              TEXT NOT NULL,
  guest_timezone           TEXT NOT NULL DEFAULT 'UTC',
  start_utc                INTEGER NOT NULL,
  end_utc                  INTEGER NOT NULL,
  -- Host-local date of the start, stamped at insert: the per-day cap is defined
  -- on host-local dates and SQLite has no timezone data to derive it.
  local_date               TEXT NOT NULL DEFAULT '',
  status                   TEXT NOT NULL DEFAULT 'confirmed',
  answers_json             TEXT NOT NULL DEFAULT '{}',
  external_event_ids_json  TEXT NOT NULL DEFAULT '{}',
  reschedule_of            TEXT,
  rescheduled_to           TEXT,
  manage_token_hash        TEXT NOT NULL,
  cancelled_at             INTEGER,
  created_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_host_start_idx      ON bookings (host_user_id, start_utc);
CREATE INDEX IF NOT EXISTS bookings_host_local_date_idx ON bookings (host_user_id, local_date);
CREATE INDEX IF NOT EXISTS bookings_event_type_idx      ON bookings (event_type_id);
CREATE INDEX IF NOT EXISTS bookings_guest_email_idx     ON bookings (guest_email);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_manage_token_idx ON bookings (manage_token_hash);

-- ===========================================================================
-- THE anti-double-booking invariant (ADR-0002 §1)
-- ===========================================================================
--
-- One row per 5-minute bucket per host, covering the booking's BUFFERED
-- footprint. The composite primary key is what makes double-booking
-- impossible: a conflicting bucket violates it, the enclosing batch() fails,
-- and no partial booking can exist.
--
-- Range overlap cannot be expressed as a SQL constraint. Discretised buckets
-- can. That substitution is the entire design.
--
-- Verified on production D1 2026-08-14 (CCC-469): a constraint violation
-- mid-batch rolls back every prior statement in that batch.
CREATE TABLE IF NOT EXISTS slot_locks (
  host_user_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  booking_id   TEXT NOT NULL,
  PRIMARY KEY (host_user_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS slot_locks_booking_idx ON slot_locks (booking_id);

-- Advisory holds (ADR-0002 §2). `hold_id` is IN the primary key, which is what
-- keeps them advisory: a hold can never collide with a slot_locks row, so it
-- suppresses a slot in listings but never blocks a booking that wins the race.
-- In D1 rather than DO storage because the slot engine runs in the Worker
-- across many hosts and cannot afford a DO round-trip per host for holds.
CREATE TABLE IF NOT EXISTS slot_holds (
  host_user_id  TEXT NOT NULL,
  bucket_start  INTEGER NOT NULL,
  hold_id       TEXT NOT NULL,
  event_type_id TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (host_user_id, bucket_start, hold_id)
);
CREATE INDEX IF NOT EXISTS slot_holds_expiry_idx ON slot_holds (expires_at);
CREATE INDEX IF NOT EXISTS slot_holds_hold_idx   ON slot_holds (hold_id);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash             TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  expires_at          INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  -- Last write bookmark, so a host never reads a replica older than their own
  -- last edit (ADR-0007 §2).
  bookmark            TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx   ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS magic_link_expiry_idx ON magic_link_tokens (expires_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  -- Stored in the clear so lookup is an indexed hit, not a table scan.
  prefix       TEXT NOT NULL,
  hash_sha256  TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  scopes_json  TEXT NOT NULL DEFAULT '[]',
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_user_idx ON webhooks (user_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT NOT NULL,
  scope         TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  status        INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (key, scope)
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at);

-- Round-robin fairness: when each member was last assigned (ADR-0004 §5).
CREATE TABLE IF NOT EXISTS rr_assignments (
  team_id          TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  last_assigned_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
