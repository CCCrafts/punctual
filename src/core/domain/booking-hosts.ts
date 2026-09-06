/**
 * Change who hosts a booking that already exists.
 *
 * A joint meeting outlives the moment it was booked: a co-host falls ill,
 * a deal needs a specialist in the room, the person who took a round-robin
 * booking hands it to a colleague. The booking itself does not move — the
 * guest's time, link and manage token are untouched — but the host set and
 * the locks that keep those hosts' calendars honest both change, and they
 * must change together.
 *
 * Same ordering as the create path (booking-service.ts): validate, write the
 * hosts and the locks in ONE batch, and only then talk to calendars and
 * email. A calendar or mail failure after the commit costs a notification,
 * never the change.
 */

import type { EnginePorts, Repositories, BucketClaim } from '../../ports.js'
import type { Booking, User } from './types.js'
import { canManageTeam } from './teams.js'
import { bookingFootprint } from '../slots/engine.js'
import { intervalToBuckets } from '../slots/intervals.js'
import { hostAddedToBookingEmail, hostRemovedFromBookingEmail } from '../email-templates.js'

export type HostChangeFailure =
  | 'not_found'
  | 'not_allowed'
  | 'not_a_team_booking'
  | 'not_a_member'
  | 'already_host'
  | 'not_host'
  | 'last_host'
  | 'slot_taken'
  /** The host list changed under the caller's feet (another edit landed first); reload and retry. */
  | 'stale'
  | 'past'

export type HostChangeResult =
  | { ok: true; booking: Booking; added: User[]; removed: User[] }
  | { ok: false; reason: HostChangeFailure }

/**
 * Add and/or remove hosts on a confirmed, future, team booking.
 *
 * Who may: any current host of the booking, or anyone who manages the
 * owning team (`canManageTeam`). Who may be added: a current member of that
 * team — membership is what makes a person bookable through the team, and
 * it is the only availability check made here. An admin putting someone on
 * a meeting outside their working hours is a decision, not a mistake; a
 * meeting that overlaps one the person already has is a mistake, and the
 * slot_locks primary key refuses it (`slot_taken`).
 */
export async function changeBookingHosts(
  ports: EnginePorts,
  actor: User,
  input: { bookingId: string; add?: string[]; remove?: string[] },
  /** The request's own repositories, so the write lands on its session bookmark and the redirect reads it back; a fresh session otherwise. */
  repositories?: Repositories,
): Promise<HostChangeResult> {
  const repos = repositories ?? ports.repositories({ consistency: 'bookmark' })

  const booking = await repos.bookings.byId(input.bookingId)
  if (!booking || booking.status !== 'confirmed') return { ok: false, reason: 'not_found' }
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType) return { ok: false, reason: 'not_found' }

  // Older rows may carry an empty list next to the primary column.
  const current = booking.hostUserIds.length > 0 ? booking.hostUserIds : [booking.hostUserId]

  // Authorization before anything else about the booking is revealed. A
  // host of the booking manages its hosts whatever their team role — it is
  // their meeting — and a team manager reaches every booking of the team.
  if (!current.includes(actor.id)) {
    const membership = eventType.ownerTeamId
      ? ((await repos.teams.memberships(actor.id)).find((m) => m.teamId === eventType.ownerTeamId) ?? null)
      : null
    if (!canManageTeam(actor, membership)) return { ok: false, reason: 'not_allowed' }
  }
  if (!eventType.ownerTeamId) return { ok: false, reason: 'not_a_team_booking' }
  if (booking.startUtc <= ports.clock.now()) return { ok: false, reason: 'past' }

  const add = [...new Set(input.add ?? [])]
  const remove = [...new Set(input.remove ?? [])]
  for (const id of remove) if (!current.includes(id)) return { ok: false, reason: 'not_host' }
  for (const id of add) if (current.includes(id)) return { ok: false, reason: 'already_host' }

  const members = new Set((await repos.teams.members(eventType.ownerTeamId)).map((m) => m.userId))
  const added: User[] = []
  for (const id of add) {
    const user = members.has(id) ? await repos.users.byId(id) : null
    if (!user) return { ok: false, reason: 'not_a_member' }
    added.push(user)
  }
  // A removed host whose account is gone is still removed — the point is
  // to free the booking of them — there is just nobody left to email.
  const removed: User[] = []
  for (const id of remove) {
    const user = await repos.users.byId(id)
    if (user) removed.push(user)
  }

  const remaining = [...current.filter((id) => !remove.includes(id)), ...add]
  if (remaining.length === 0) return { ok: false, reason: 'last_host' }
  // The primary host is whose timezone the per-day cap and host-facing mail
  // use. When they leave, the first host still on the booking takes over —
  // there is no better-founded choice, and it keeps `hostUserId` a member
  // of `hostUserIds`, which every reader assumes.
  const primary = remove.includes(booking.hostUserId) ? remaining[0]! : booking.hostUserId

  // The SAME footprint the create path claimed (ADR-0004 §4): meeting plus
  // the event type's buffers, on the 5-minute grid. An added host claims
  // every bucket of it, exactly as they would have had they been on the
  // booking from the start.
  const bucketStarts = intervalToBuckets(bookingFootprint(booking.startUtc, booking.endUtc, eventType))
  const claim: BucketClaim[] = []
  for (const id of add) for (const b of bucketStarts) claim.push({ hostUserId: id, bucketStart: b })
  const release: BucketClaim[] = []
  for (const id of remove) for (const b of bucketStarts) release.push({ hostUserId: id, bucketStart: b })

  if (add.length === 0 && remove.length === 0) return { ok: true, booking, added, removed }

  const updated = await repos.bookings.replaceHosts(booking.id, booking.hostUserIds, remaining, primary, claim, release)
  if (!updated) {
    // Nothing changed either way; which reason depends on whether the
    // booking is still there to change, and whether someone else changed
    // it first (the compare-and-swap lost) — that is a stale page, not a
    // taken slot.
    const again = await repos.bookings.byId(booking.id)
    if (!again || again.status !== 'confirmed') return { ok: false, reason: 'not_found' }
    if (JSON.stringify(again.hostUserIds) !== JSON.stringify(booking.hostUserIds)) return { ok: false, reason: 'stale' }
    return { ok: false, reason: 'slot_taken' }
  }

  // ---- after the commit: calendars and email, best-effort ----

  // The provider events get the new attendee list; a host added on a
  // provider that has no event yet gets one (consumer.ts, `update`). The
  // event a removed host organized is NOT deleted: the guest and the other
  // hosts are on it, and it is the one event that provider has for this
  // meeting. The removed host keeps a copy on their own calendar and is
  // told to decline it.
  await ports.queue
    .send({ kind: 'calendar.sync', bookingId: booking.id, action: 'update' })
    .catch((err) => console.error('[punctual] host-change calendar sync failed to queue', err))


  // The guest is not emailed: their meeting has not moved and the link is
  // the same. The attendee list in the .ics they already hold goes stale —
  // accepted for now; the provider event is what their calendar actually
  // shows, and that is updated above.
  const names = new Map<string, string>()
  for (const id of remaining) {
    const user = added.find((u) => u.id === id) ?? (await repos.users.byId(id))
    if (user) names.set(id, user.name || user.slug)
  }
  const shared = {
    brandName: ports.config.brandName,
    eventTitle: eventType.title,
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    startUtc: booking.startUtc,
    endUtc: booking.endUtc,
    hostNames: remaining.map((id) => names.get(id)).filter((n): n is string => Boolean(n)),
    editorName: actor.name || actor.slug,
    bookingUrl: `${ports.config.baseUrl.replace(/\/$/, '')}/dashboard/bookings/${booking.id}`,
    ...(ports.config.supportEmail ? { supportEmail: ports.config.supportEmail } : {}),
  }
  const mail = async (user: User, kind: 'added' | 'removed') => {
    // Never to the editor about themselves: a host taking themselves off
    // a meeting knows.
    if (user.id === actor.id) return
    const render = kind === 'added' ? hostAddedToBookingEmail : hostRemovedFromBookingEmail
    const content = render({ ...shared, hostName: user.name || user.slug, hostTz: user.tz })
    await ports.email
      .send({ to: user.email, toName: user.name, subject: content.subject, html: content.html, text: content.text })
      .catch((err) => console.error(`[punctual] host-${kind} email not sent`, err))
  }
  for (const user of added) await mail(user, 'added')
  for (const user of removed) await mail(user, 'removed')

  return { ok: true, booking: updated, added, removed }
}
