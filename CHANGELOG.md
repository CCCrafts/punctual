# Changelog

All notable changes to the Punctual engine. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); pre-1.0, minor versions may
still change interfaces.

## [Unreleased]

## [0.1.1] — 2026-08-19

Release-readiness fixes found while checking 0.1.0 against its own claims —
no behavior change for a deployed instance.

- README quoted a stale test count (454); the suite is at 525.
- `schema.ts`, the Drizzle mirror of the D1 schema, was silently missing
  migration 0006 (`users.role`, `instance_settings`). No functional impact —
  every repository queries D1 with raw SQL, nothing reads through Drizzle's
  schema object at runtime — but it's checked into the repo as the schema's
  own documentation and was quietly wrong.
- Opt-in telemetry pinged `telemetry.punctual.io`, a domain this project
  does not own (`.sh` is canonical — ADR-0008); a stray doc-comment example
  in `ports.ts` had the same stale domain. Neither is reachable behind the
  scenes yet, so this was a silent no-op either way, not a live leak — fixed
  before it could become one.

## [0.1.0] — 2026-08-19

The first release: a complete single-team scheduler on Cloudflare Workers,
from an empty repo to a deployed product in six days. Everything below ships
under MIT with no seat limits and no gated features — see the pledge in the
README.

### Scheduling core

- Slot engine with explicit DST rules (spring-forward clamps, fall-back
  takes the first occurrence), tested across Kyiv, New York, Lord Howe,
  Chatham, Kolkata and the southern hemisphere.
- Double-booking made impossible at the storage layer: one `slot_locks` row
  per five-minute bucket per host, primary key `(host_user_id,
  bucket_start)`, written in the same D1 batch as the booking. Verified
  against production D1; guarded by standing race-condition tests.
- Event types with buffers, notice windows, horizons, daily caps, slot
  intervals and custom questions; a built-in optional "What would you like
  to discuss?" question flows to the calendar event and both confirmation
  emails, and a host's own `Agenda |` question line replaces it.
- Teams with round-robin (weighted, last-assigned tie-break) and collective
  scheduling.
- Availability schedules with weekly windows and date overrides, all UTC
  internally; per-day caps respect each host's own timezone.

### Calendar sync

- Google Calendar and Microsoft 365 connectors using the deployment's own
  OAuth apps; busy-time reads widened to cover buffers, "working elsewhere"
  correctly read as free, reschedules can never lose to their own stale
  calendar entry.
- OAuth tokens encrypted at rest (AES-GCM, versioned keys, AAD binding
  ciphertext to its row); identity and calendar flows use separate redirect
  URIs so an authorization code for one can never be exchanged against the
  other.

### Booking surface

- Booking pages rendered and streamed from the edge (TTFB roughly halved by
  collapsing round trips), with a real timezone picker, host identity block
  (photo, name, position, company with an optional link), live month/day
  views, and a rate limit on public GETs.
- Guest manage links: signed, single-purpose, rotating on reschedule;
  reschedule and cancel notify both parties, including the new host on a
  round-robin reassignment.
- Transactional email (Resend or Brevo) with `.ics` invites, 24 h and 1 h
  reminders, recipient-timezone rendering, and copy that only claims an
  invite is attached when one actually is.
- Embed widget with correct iframe resizing across the whole multi-step
  flow; dynamic per-booking-page Open Graph cards rendered at the edge and
  cached in KV.

### Dashboard

- Magic-link and Google/Microsoft sign-in behind one account model, with no
  account-existence oracle in either the response bytes or the timing.
- Event types, availability, calendar connections and selection, API keys,
  bookings with host-side reschedule/cancel.
- Profile: photo upload (R2-backed, resized server-side at upload time,
  originals never served — only re-encoded metadata-free thumbnails), name,
  position, company and company link, booking-page slug changes with
  collision safety.
- Admin: the first user of a fresh instance bootstraps as admin; admins
  manage users (grant/revoke admin with an atomic last-admin guard) and the
  sign-up policy — open, closed, or an allowlist of emails and domains —
  from the dashboard, with the `SIGNUPS` variable available to pin it from
  configuration instead.

### API and agents

- REST API covering event types, availability, slots, bookings and webhooks,
  authenticated by scoped API keys, with idempotency keys arbitrated by the
  database.
- HMAC-signed webhooks that report a cancelled booking as cancelled.
- A built-in MCP server exposing scheduling as tools an AI agent can call,
  scoped to exactly the calling key's authority.

### Security hardening along the way

Found by adversarial dual-model review before each merge, fixed before
release: an EXIF-leaking avatar route (originals are no longer reachable), a
timing oracle in the closed-signups path, a whitespace-padding bypass of the
answer length cap that could overflow queued emails, an image decompression
bomb ahead of the resizer, header injection via guest names, and concurrent
admin demotions racing to a zero-admin lockout.

### Docs and self-hosting

- A self-hosting guide from zero to a booking link on Cloudflare's free
  tier, served both in the repo and on the deployment's own `/docs` pages,
  including a "make it yours" walkthrough (profile, sign-up policy,
  operator naming, landing demo embed).
- Brand assets, self-hosted fonts with a stable first paint, light and dark
  themes, and a semantic design-token layer for the product UI.

[Unreleased]: https://github.com/CCCrafts/punctual/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/CCCrafts/punctual/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/CCCrafts/punctual/releases/tag/v0.1.0
