-- A logo per event type: heads its booking page and social card instead of
-- the host's photo or the team's logo. Same key convention as users.avatar_key
-- and teams.logo_key — the resized thumbnail's blob key. Additive.
ALTER TABLE event_types ADD COLUMN logo_key TEXT;
