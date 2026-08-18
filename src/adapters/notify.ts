/**
 * Booking notifications.
 *
 * Lives beside the coordinator because the coordinator is the single path every
 * booking takes (ADR-0002). The web booking flow previously enqueued only the
 * calendar sync, so a guest who booked through the site received no
 * confirmation at all — spec §4.1 requires both parties to get an email with an
 * .ics attachment, and only the REST path did it.
 *
 * Everything here is best-effort and runs AFTER the commit. A mail provider
 * having a bad minute must never cost a booking we already confirmed on screen.
 */

import type { Booking, EventType, User } from '../core/domain/types.js'
import type { EnginePorts } from '../ports.js'
import {
  bookingCancelled,
  bookingConfirmationForGuest,
  bookingConfirmationForHost,
  bookingRescheduled,
} from '../core/email-templates.js'
import {
  ICS_CANCEL_CONTENT_TYPE,
  buildIcs,
  icsCancelSuppressed,
  icsSequenceForBooking,
  icsUidForBooking,
} from '../core/ics.js'

/** A booking known to have no predecessor gets an empty chain, not `undefined`. */
const NO_CHAIN: ReadonlyMap<string, Booking> = new Map()

export interface NotifyContext {
  ports: EnginePorts
  booking: Booking
  eventType: EventType
  /** The assigned host; for collective, the primary. */
  host: User
  hosts?: User[]
  /** Raw manage token, so the emails can carry a working link. */
  manageToken?: string
}

/**
 * Confirmations for guest and host, each with the same .ics.
 *
 * The attachment is METHOD:REQUEST so calendar clients offer to add it. The
 * UID is stable across a reschedule chain and the SEQUENCE increases, which is
 * what makes a client UPDATE the existing event rather than create a duplicate
 * — the single most commonly botched part of .ics.
 */
export async function notifyBookingCreated(ctx: NotifyContext): Promise<void> {
  const { ports, booking, eventType, host } = ctx

  // The replacement booking of a reschedule already gets a "Rescheduled" mail
  // from the route that moved it. Sending "Confirmed" as well gives the guest
  // two contradictory emails for one action.
  if (booking.rescheduleOf) return
  const manageUrl = ctx.manageToken
    ? `${ports.config.baseUrl}/booking/${booking.id}?token=${encodeURIComponent(ctx.manageToken)}`
    : undefined

  let ics: string | undefined
  try {
    // `booking.rescheduleOf` is guaranteed null by the early return above, so
    // this booking is always a root and an empty chain is the correct chain
    // — not a shortcut, since `icsUidForBooking`/`icsSequenceForBooking`
    // require one explicitly rather than defaulting it away.
    ics = buildIcs({
      uid: icsUidForBooking(booking, NO_CHAIN),
      sequence: icsSequenceForBooking(booking, NO_CHAIN),
      method: 'REQUEST',
      booking,
      eventType,
      organizer: { email: host.email, name: host.name || host.slug },
      attendees: [
        { email: booking.guestEmail, name: booking.guestName },
        ...(ctx.hosts ?? [host]).map((h) => ({ email: h.email, name: h.name || h.slug })),
      ],
      ...(manageUrl ? { url: manageUrl } : {}),
    })
  } catch (err) {
    // A malformed invitation must not stop the confirmation itself: an email
    // saying "you're booked" with no attachment still beats silence.
    console.error('[punctual] ics generation failed', err)
  }

  // Cloudflare Queues caps a message at 128 KB. A host with many long custom
  // questions can push the .ics past that, and a rejected batch would lose the
  // confirmation ENTIRELY — so the attachment is dropped before the email is.
  const encoded = ics ? base64(ics) : undefined
  const attachments =
    encoded && encoded.length <= 40_000
      ? [{ filename: 'invite.ics', content: encoded, contentType: 'text/calendar; method=REQUEST' }]
      : undefined
  if (encoded && !attachments) {
    console.warn('[punctual] .ics too large to attach; sending confirmation without it')
  }

  const shared = {
    booking,
    eventType,
    host,
    ...(ctx.hosts ? { hosts: ctx.hosts } : {}),
    brandName: ports.config.brandName,
    supportEmail: ports.config.supportEmail,
    ...(manageUrl ? { rescheduleUrl: manageUrl, cancelUrl: manageUrl } : {}),
    hasAttachment: Boolean(attachments),
  }

  const guest = bookingConfirmationForGuest(shared)
  const hostMail = bookingConfirmationForHost(shared)

  // Sent independently rather than as one batch: a batch is atomic, so an
  // oversized or malformed host message would take the guest's confirmation
  // down with it.
  await Promise.all([
    ports.queue
      .send({
        kind: 'email',
        message: {
          to: booking.guestEmail,
          toName: booking.guestName,
          subject: guest.subject,
          html: guest.html,
          text: guest.text,
          ...(attachments ? { attachments } : {}),
        },
      })
      .catch((err) => console.error('[punctual] guest confirmation failed to queue', err)),
    ports.queue
      .send({
        kind: 'email',
        message: {
          to: host.email,
          toName: host.name || host.slug,
          subject: hostMail.subject,
          html: hostMail.html,
          text: hostMail.text,
          ...(attachments ? { attachments } : {}),
          replyTo: booking.guestEmail,
        },
      })
      .catch((err) => console.error('[punctual] host notification failed to queue', err)),
    notifyWebhooks(ports, 'booking.created', booking, eventType),
  ])
}

/**
 * Fan a booking event out to the host's registered webhooks.
 *
 * `deliverWebhook` in the queue consumer was fully implemented and
 * `POST /api/v1/webhooks` handed back a signing secret, but nothing anywhere
 * ever enqueued a `webhook` message — so a subscriber registered an endpoint,
 * got a 201, and never received anything. The README advertises them.
 */
export async function notifyWebhooks(
  ports: EnginePorts,
  event: 'booking.created' | 'booking.rescheduled' | 'booking.cancelled',
  booking: Booking,
  eventType: EventType,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'unconstrained' })
  // Every participating host's subscriptions, not just the primary's — a
  // collective booking is equally an event for each of them.
  const seen = new Set<string>()
  for (const hostId of booking.hostUserIds.length > 0 ? booking.hostUserIds : [booking.hostUserId]) {
    const hooks = await repos.webhooks.listForUser(hostId).catch(() => [])
    for (const hook of hooks) {
      if (seen.has(hook.id) || !hook.events.includes(event)) continue
      seen.add(hook.id)
      await ports.queue
        .send({
          kind: 'webhook',
          webhookId: hook.id,
          event,
          payload: {
            id: booking.id,
            eventTypeId: eventType.id,
            eventTypeSlug: eventType.slug,
            title: eventType.title,
            hostUserId: booking.hostUserId,
            hostUserIds: booking.hostUserIds,
            guestName: booking.guestName,
            guestEmail: booking.guestEmail,
            guestTimezone: booking.guestTimezone,
            start: new Date(booking.startUtc).toISOString(),
            end: new Date(booking.endUtc).toISOString(),
            status: booking.status,
            rescheduleOf: booking.rescheduleOf,
            answers: booking.answers,
          },
          attempt: 0,
        })
        .catch((err) => console.error('[punctual] webhook failed to queue', err))
    }
  }
}

/**
 * Walk back the reschedule chain so the UID stays anchored to its root.
 *
 * Without this a two-hop move (A→B→C) produces C's UID from B, and the guest's
 * client creates a SECOND event instead of updating the first.
 */
async function loadChain(
  ports: EnginePorts,
  booking: Booking,
): Promise<ReadonlyMap<string, Booking>> {
  const chain = new Map<string, Booking>()
  const repos = ports.repositories({ consistency: 'unconstrained' })
  let cursor: string | null = booking.rescheduleOf
  let guard = 0
  while (cursor && guard++ < 20) {
    const prev: Booking | null = await repos.bookings.byId(cursor)
    if (!prev) break
    chain.set(prev.id, prev)
    cursor = prev.rescheduleOf
  }
  return chain
}

/**
 * The invitation for an existing booking.
 *
 * Same UID as the original plus a higher SEQUENCE is what makes a calendar
 * client UPDATE the event rather than add a duplicate — and without it the
 * emails were telling the guest "the updated invite is attached" while
 * attaching nothing, leaving the old time sitting in their calendar.
 */
async function buildAttachment(
  ports: EnginePorts,
  booking: Booking,
  eventType: EventType,
  host: User,
  hosts: User[] | undefined,
  method: 'REQUEST' | 'CANCEL',
  url?: string,
): Promise<Array<{ filename: string; content: string; contentType: string }> | undefined> {
  // A booking that has itself been superseded by a later reschedule
  // (`rescheduledTo` set) must never get a CANCEL .ics: its replacement's
  // REQUEST shares the same UID, and a CANCEL computed from this booking's
  // own chain depth has no way to see the replacement's SEQUENCE — the two
  // can collide on the same number for the same UID, and a client that
  // resolves the conflict by DTSTAMP can then drop the replacement, leaving
  // the guest with nothing on their calendar instead of the moved meeting.
  // No caller reaches this today with a superseded booking (every cancel
  // entry point requires status 'confirmed', and a superseded booking is
  // 'rescheduled'), but per `icsCancelSuppressed`'s docstring this must hold
  // by construction, not by the accident of every call site remembering the
  // status check.
  if (method === 'CANCEL' && icsCancelSuppressed(booking)) return undefined
  try {
    const chain = await loadChain(ports, booking)
    const ics = buildIcs({
      uid: icsUidForBooking(booking, chain),
      sequence: icsSequenceForBooking(booking, chain, method === 'CANCEL'),
      method,
      booking,
      eventType,
      organizer: { email: host.email, name: host.name || host.slug },
      attendees: [
        { email: booking.guestEmail, name: booking.guestName },
        ...(hosts ?? [host]).map((h) => ({ email: h.email, name: h.name || h.slug })),
      ],
      ...(url ? { url } : {}),
    })
    const encoded = base64(ics)
    if (encoded.length > 40_000) return undefined
    return [
      {
        filename: 'invite.ics',
        content: encoded,
        contentType: method === 'CANCEL' ? ICS_CANCEL_CONTENT_TYPE : 'text/calendar; method=REQUEST',
      },
    ]
  } catch (err) {
    // An email with no attachment still beats no email.
    console.error('[punctual] ics generation failed', err)
    return undefined
  }
}

/**
 * Base64 for the .ics body.
 *
 * Encodes UTF-8 bytes rather than code units: `btoa` throws on any character
 * above U+00FF, and event titles routinely contain them.
 */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * Cancellation, to BOTH parties.
 *
 * Lives here rather than in a route because both the REST path and the guest
 * manage page cancel, and only one of them was notifying anyone — while the
 * guest-facing page told the reader "the host is notified", which was simply
 * untrue on that path.
 */
export async function notifyBookingCancelled(ctx: {
  ports: EnginePorts
  booking: Booking
  eventType: EventType
  host: User
  hosts?: User[]
  cancelledBy: 'host' | 'guest'
  reason?: string
}): Promise<void> {
  const { ports, booking, eventType, host } = ctx
  const shared = {
    booking,
    eventType,
    host,
    ...(ctx.hosts ? { hosts: ctx.hosts } : {}),
    cancelledBy: ctx.cancelledBy,
    ...(ctx.reason ? { reason: ctx.reason } : {}),
    brandName: ports.config.brandName,
    supportEmail: ports.config.supportEmail,
  }

  const guest = bookingCancelled({ ...shared, audience: 'guest' })
  const hostMail = bookingCancelled({ ...shared, audience: 'host' })

  // METHOD:CANCEL with the chain's UID and a higher SEQUENCE — this is what
  // actually removes the meeting from the guest's own calendar. The email copy
  // already claims it has been removed.
  const attachments = await buildAttachment(
    ports, booking, eventType, host, ctx.hosts, 'CANCEL',
  )

  await Promise.all([
    ports.queue
      .send({
        kind: 'email',
        message: {
          to: booking.guestEmail,
          toName: booking.guestName,
          subject: guest.subject,
          html: guest.html,
          text: guest.text,
          ...(attachments ? { attachments } : {}),
        },
      })
      .catch((err) => console.error('[punctual] guest cancellation failed to queue', err)),
    ports.queue
      .send({
        kind: 'email',
        message: {
          to: host.email,
          toName: host.name || host.slug,
          subject: hostMail.subject,
          html: hostMail.html,
          text: hostMail.text,
          ...(attachments ? { attachments } : {}),
        },
      })
      .catch((err) => console.error('[punctual] host cancellation failed to queue', err)),
    notifyWebhooks(ports, 'booking.cancelled', booking, eventType),
  ])
}

/**
 * A move, to BOTH parties.
 *
 * `notifyBookingCreated` deliberately skips a booking with `rescheduleOf` set,
 * on the assumption that the route which moved it sends this instead. That was
 * only true of the REST path — the guest manage page sent nothing at all, so a
 * guest who moved their own meeting received no confirmation of the new time.
 */
export async function notifyBookingRescheduled(ctx: {
  ports: EnginePorts
  booking: Booking
  previous: Booking
  eventType: EventType
  host: User
  hosts?: User[]
  manageToken?: string
}): Promise<void> {
  const { ports, booking, eventType, host } = ctx
  const manageUrl = ctx.manageToken
    ? `${ports.config.baseUrl}/booking/${booking.id}?token=${encodeURIComponent(ctx.manageToken)}`
    : undefined

  // Computed before `shared`, not after: the copy claims an invite is
  // attached, and that claim has to be true. A .ics that exceeded the size
  // cap or failed to generate is dropped before the email is (buildAttachment
  // itself), so the templates need to know which happened rather than assume.
  //
  // Same UID as the original, higher SEQUENCE: the client moves the existing
  // event instead of leaving the old time and adding a second one.
  const attachments = await buildAttachment(
    ports, booking, eventType, host, ctx.hosts, 'REQUEST', manageUrl,
  )

  const shared = {
    booking,
    eventType,
    host,
    ...(ctx.hosts ? { hosts: ctx.hosts } : {}),
    previous: { startUtc: ctx.previous.startUtc, endUtc: ctx.previous.endUtc },
    brandName: ports.config.brandName,
    supportEmail: ports.config.supportEmail,
    ...(manageUrl ? { rescheduleUrl: manageUrl, cancelUrl: manageUrl } : {}),
    hasAttachment: Boolean(attachments),
  }

  const guest = bookingRescheduled({ ...shared, audience: 'guest' })
  const hostMail = bookingRescheduled({ ...shared, audience: 'host' })

  await Promise.all([
    ports.queue
      .send({
        kind: 'email',
        message: {
          to: booking.guestEmail,
          toName: booking.guestName,
          subject: guest.subject,
          html: guest.html,
          text: guest.text,
          ...(attachments ? { attachments } : {}),
        },
      })
      .catch((err) => console.error('[punctual] guest reschedule mail failed to queue', err)),
    ports.queue
      .send({
        kind: 'email',
        message: {
          to: host.email,
          toName: host.name || host.slug,
          subject: hostMail.subject,
          html: hostMail.html,
          text: hostMail.text,
          replyTo: booking.guestEmail,
          ...(attachments ? { attachments } : {}),
        },
      })
      .catch((err) => console.error('[punctual] host reschedule mail failed to queue', err)),
    notifyWebhooks(ports, 'booking.rescheduled', booking, eventType),
  ])
}
