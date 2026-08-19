-- An optional link for the host's company, wrapped around the company name
-- on the booking page.
--
-- Forward-only and additive (ADR-0006 §4): nullable with no default.

ALTER TABLE users ADD COLUMN company_url TEXT;
