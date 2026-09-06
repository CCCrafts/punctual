-- The timezone the sign-in form's browser reported, carried on the magic
-- link so the default schedule created on redemption is in the host's own
-- zone rather than UTC.
--
-- Forward-only and additive (ADR-0006 §4): nullable with no default. Rows
-- without it (links sent before this migration, forms submitted without
-- script) fall back to the redeeming request's network location.

ALTER TABLE magic_link_tokens ADD COLUMN timezone TEXT;
