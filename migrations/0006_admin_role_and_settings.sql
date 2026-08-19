-- Instance administration: user roles and operator-editable settings.
--
-- Forward-only and additive (ADR-0006 §4). Existing users become 'member';
-- nobody is silently promoted — a fresh instance bootstraps its first user
-- as admin in code, and an existing deployment promotes one explicitly (see
-- docs/self-hosting.md).

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

CREATE TABLE IF NOT EXISTS instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
