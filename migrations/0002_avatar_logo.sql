-- Avatar and team-logo upload (CCC-543).
--
-- Forward-only and additive (ADR-0006 §4): both columns are nullable with no
-- default, so an existing row simply has no avatar/logo until its host
-- uploads one — no backfill needed, no migration step required to succeed.

ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE teams ADD COLUMN logo_key TEXT;
