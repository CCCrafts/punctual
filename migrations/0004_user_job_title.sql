-- A host's job title/position, shown with the company on the booking page
-- and in confirmation emails.
--
-- Forward-only and additive (ADR-0006 §4): nullable with no default, so an
-- existing row simply has no title until its host sets one.

ALTER TABLE users ADD COLUMN job_title TEXT;
