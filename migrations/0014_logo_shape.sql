-- How a logo is shown: 'circle' (square crop in a round mask, the only
-- shape until now) or 'natural' (original proportions, aligned by height,
-- no crop). Uploads from here on also store an uncropped "-fit.webp"
-- thumbnail next to the square one; a logo uploaded earlier gets its fit
-- variant regenerated from the stored original when first switched.
ALTER TABLE event_types ADD COLUMN logo_shape TEXT NOT NULL DEFAULT 'circle';
ALTER TABLE teams ADD COLUMN logo_shape TEXT NOT NULL DEFAULT 'circle';
