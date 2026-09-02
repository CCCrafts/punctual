-- The conference link, and a record of whether the confirmation was sent.
--
-- Forward-only and additive (ADR-0006 §4). Both columns are nullable with no
-- backfill: an existing booking genuinely has no captured link (the engine
-- discarded it until now) and genuinely has an unknown confirmation time, and
-- inventing a value for either would be worse than saying "unknown".

-- The meeting link Google/Graph minted for THIS booking. Per-booking, not
-- per-event-type: a reschedule creates a fresh external event and a fresh link.
ALTER TABLE bookings ADD COLUMN conference_url TEXT;

-- When this booking's confirmation was claimed for sending. The calendar-sync
-- handler is what dispatches confirmations now — it is the first point that
-- knows the conference link — and a queue retry re-runs that handler, so this
-- column is the thing a conditional UPDATE claims to make the send
-- exactly-once. It doubles as a straight answer to "did this booking's
-- confirmation ever go out?", which nothing could answer during the
-- silent-email incident that preceded this work.
ALTER TABLE bookings ADD COLUMN confirmation_queued_at INTEGER;

-- Backfill every EXISTING booking as already-confirmed-sent.
--
-- Those bookings got their confirmation from the old coordinator path before
-- this deploy. Leaving the column NULL would let a `calendar.sync create`
-- message that straddles the deploy — redelivery with backoff makes that a
-- real window — pass the new exactly-once claim and send the guest a SECOND
-- confirmation for a meeting they already know about. `created_at` is the
-- honest timestamp: it is when that confirmation actually went out.
UPDATE bookings SET confirmation_queued_at = created_at WHERE confirmation_queued_at IS NULL;
