-- Shared slug namespace across users and teams.
--
-- users.slug and teams.slug each have their own UNIQUE index, but nothing
-- spans the two — bookingPageContext resolves a public page's owner slug
-- against EITHER table with no precedence, so a signup and a team creation
-- can each independently win their own table's constraint while claiming
-- the exact same slug: both checks (uniqueSlug in auth-flows.ts, the
-- team-create and settings routes in dashboard-routes.ts) read both tables
-- before either write commits, and nothing before this table arbitrated the
-- two writes against each other. This table is the real constraint: one row
-- per claimed slug, written in the SAME batch as the user or team row that
-- claims it.
--
-- Forward-only and additive (ADR-0006 §4).
CREATE TABLE IF NOT EXISTS slug_claims (
  slug       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,   -- 'user' | 'team'
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS slug_claims_owner_idx ON slug_claims (kind, owner_id);

-- Backfill: existing users first, existing teams second. If any slug is
-- already shared across a user and a team — only possible via the exact
-- race this table closes — the first writer here keeps the claim and the
-- second is silently skipped. That is pre-existing bad data with no clean
-- automatic resolution; this migration stops the race going forward, it
-- does not retroactively decide an already-ambiguous page's ownership.
INSERT OR IGNORE INTO slug_claims (slug, kind, owner_id, created_at)
  SELECT slug, 'user', id, created_at FROM users;
INSERT OR IGNORE INTO slug_claims (slug, kind, owner_id, created_at)
  SELECT slug, 'team', id, created_at FROM teams;
