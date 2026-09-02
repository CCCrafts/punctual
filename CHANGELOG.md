# Changelog

All notable changes to the Punctual engine. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); pre-1.0, minor versions may
still change interfaces.

## [Unreleased]

## [0.3.0] — 2026-09-02

Host groups: a team event type now names its hosts. Team roles that mean
something, an explicit host set with required and optional hosts and a
per-host schedule, a booking page that says who the guest will meet, one
calendar invite per provider with every host on it, the same over the
REST API and MCP, and social cards with faces. Every change went through
the dual-model review this repo runs; the findings are folded in.

### Added

- **Team roles mean something** (migration `0010`). A team's admins manage
  its members and roles, own its event types, and can set up or edit any
  member's availability schedules on their behalf — from a per-member
  availability page under the team. A plain member hosts the team's
  meetings, sees its event types read-only, and keeps full control of their
  own schedules, including ones an admin created, which are badged with who
  set them up. The instance admin manages every team. Guards live in the
  database, not the request handler: a team's last admin can be neither
  demoted nor removed, in the same single-statement style as the instance's
  last-admin guard. Existing teams keep their creator as admin; a team that
  somehow had no admin gets its earliest member promoted by the migration.
- **Explicit hosts per team event type** (migration `0011`, table
  `event_type_hosts`). A team event type can name a subset of the team as
  its hosts, in order, each with their own schedule for this event type
  and, for round-robin, their own weight. Collective hosts are *required*
  or *optional*: slots are the intersection of the required hosts' free
  time, and an optional host joins a booking when free and is left out when
  not — the booking records who actually attends, and only they are locked.
  No rows means what it always meant: every member, required, on their
  default schedules. Both references are guarded inside the write (host
  must be on the team, schedule must be the host's), the set is replaced
  atomically or not at all, and a required host of an active event type
  cannot be removed from the team until they are taken off it. The three
  private copies of "who hosts this" in the booking page, the dashboard and
  the API are now one resolver. The dashboard and API surfaces for editing
  the set follow in their own changes.
- **Hosts block on a team event type's edit page.** A team admin ticks who
  hosts it, marks each collective host required or optional (or gives a
  round-robin host a per-event weight), and picks which of that member's
  schedules the event type draws from — by name, with a link to set a new
  one up on the member's behalf. Left at its defaults the list stays
  implicit and new members keep joining automatically; touched, it becomes
  the event type's own list. A newly added host gets an email saying which
  of their schedules the slots will use and where to change it; creating a
  team event type lands on its edit page and tells every other member.
- **"Team events" on the Availability page**: each team event type a host
  is on, with a select of their own schedules for it — the host's side of
  the same setting, changeable at any time.
- **The booking page says who the guest will meet.** A team-owned page is
  headed by the team's name and logo instead of one representative member,
  and a hosts row under the header names the hosts with their avatars:
  collective "You'll meet Alice, Bob and Carol", round robin "With one of
  Alice, Bob or Carol" — never a specific person, since the host is picked
  at commit. More than four collapses to three and a CSS-only "and N more".
  The confirmation screen names the people who actually attend: the
  round-robin pick, or the required hosts plus the optional ones that were
  free.
- **One calendar event per booking per provider** (ADR-0011). A team
  booking used to be written once per host connection, each event listing
  only that host and the guest, so co-hosts never saw each other. Now the
  first host with a connected calendar on each provider organizes that
  provider's one event and every host on the provider is an attendee of
  it, optional hosts flagged optional (Google `optional`, Graph `type:
  optional`). A host's second account on the same provider is invited by
  its own address; a host with no calendar is listed on the first event by
  address (which lands only for an account on that provider — every host
  gets Punctual's own confirmation with the `.ics` regardless). Cancel
  walks the stored event ids, so bookings written in the old shape keep
  cancelling.
- **REST and MCP know about hosts.** Every event-type response carries
  `ownerTeamId` and `hosts[]` (`userId`, `name`, `required`, `weight`,
  `scheduleId`). `POST /event-types` creates a team event type with
  `ownerTeamId`, `schedulingType` and `hosts[]` for a team admin's key;
  `PATCH` replaces `hosts[]` atomically; `PATCH /event-types/:id/hosts/:userId`
  sets one host's per-event schedule — the host's own key, or a team
  admin's, and a 403 that names who can otherwise. Team admins manage a
  member's schedules over the API too: `GET`/`POST
  /teams/:id/members/:userId/schedules` and `PATCH …/:sid`, created rows
  badged with `createdBy`. MCP `list_event_types` names each team event
  type's hosts and whether they are required; `create_booking` reports who
  actually attends.
- **The social card shows who the meeting is with.** A personal booking
  page's OG image carries the host's photo (or their initial on the brand
  green); a team page's carries up to three hosts as a stack and a "+N"
  disc, named for collective ("with Alice, Bob and Carol") and by team for
  round robin ("with the Support team"). Thumbnails are re-encoded from
  WebP to PNG for the renderer; the cache key carries host ids and avatar
  keys, so a new photo or a changed host list is a new card.
- REST: `PATCH`/`DELETE /event-types/:id` on a team-owned event type now
  require a team admin's key (403 otherwise); reading and listing are
  unchanged for every member.

## [0.2.0] — 2026-08-24

Named availability schedules, a redesigned weekly-hours editor, a CLI
installer, and a body of race-condition and booking-page fixes — most found
by the dual-model review process this repo runs on every change.

### Added

- **Named availability schedules** (migration `0007`): a host can keep
  several schedules ("Working hours", "Evenings") and assign one per event
  type; unassigned event types follow the default. Guarded at the database,
  not in application code: one default per user via a partial unique index,
  delete blocked while an event type still points at a schedule, and the
  event-type ↔ schedule link written with a scalar-subquery guard so a
  concurrent schedule delete cannot leave a dangling reference.
- **Redesigned weekly-hours editor**: per-day toggle switches and native
  time inputs with one or more ranges per day (lunch-break splits), a
  no-JavaScript "+ Add range" round trip, and a CSS-only show/hide — the
  whole editor works with scripts disabled. In-progress typing survives
  validation errors and add-range round trips instead of reverting.
- **`punctual-sh` CLI** (`cli/`, published to npm; installs a `punctual`
  binary): `punctual init` runs the whole self-host quick start — creates
  the D1/KV/R2/Queues resources, writes their ids into `wrangler.toml`,
  generates secrets, migrates and deploys, idempotently and resumably —
  and refuses to adopt or overwrite any resource it did not create, in any
  Cloudflare account, by design. `punctual slots` prints live availability
  from a running instance. Terminal identity per the brand: the wordmark's
  green colon, shape-distinct status glyphs, no color when piped or under
  `NO_COLOR`.
- Booking page defaults to today's slots on first load instead of "Pick a
  day", and the calendar highlights the selected day (and moves the
  highlight when the guest switches days).
- New accounts are bookable from creation: a default schedule is
  provisioned at signup and backfilled on login for accounts that predate
  it — previously a new host had no availability until they saved the form
  once.
- Optional GA4 analytics, scoped strictly to the marketing/docs pages.

### Fixed

- **Cross-table slug race** (migration `0008`): user signup and team
  creation share one slug namespace but arbitrated it in application code;
  two concurrent requests could claim the same slug. A `slug_claims` table
  now makes the database the arbiter, written in the same atomic batch as
  the row that claims the name.
- A family of agenda-question edge cases: duplicated question when a
  host's custom wording matches the builtin, legacy answers hidden after a
  same-labeled replacement, stale-form loss of answers when a host edits
  mid-fill, and a blank direct answer shadowing a filled older one.
- Calendar month clamping no longer hides the last bookable day from
  guests far behind the host's timezone, and the day panel can no longer
  render for a month the calendar isn't showing.
- Email templates: rendered and verified in real clients; fixed a broken
  avatar-alt fallback, a raw IANA timezone id in the footer, and spacing
  between the secondary action and the footer rule.
- The public-page footer wordmark links to punctual.sh (new tab) rather
  than the deployment's own homepage, and no longer inherits a
  deployment's custom brand name.
- Flaky wall-clock tests (rate limiter, "defaults to today") made
  deterministic by measuring elapsed time instead of assuming it.

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
