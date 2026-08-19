-- A host's company/organisation, shown next to their name on the booking
-- page and in confirmation emails.
--
-- Forward-only and additive (ADR-0006 §4): nullable with no default, so an
-- existing row simply has no company until its host sets one.

ALTER TABLE users ADD COLUMN company TEXT;
