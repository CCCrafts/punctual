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
import { buildIcs, icsSequenceForBooking, icsUidForBooking } from '../core/ics.js'

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
    ics = buildIcs({
      uid: icsUidForBooking(booking),
      sequence: icsSequenceForBooking(booking),
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
  ])
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
        },
      })
      .catch((err) => console.error('[punctual] host cancellation failed to queue', err)),
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

  const shared = {
    booking,
    eventType,
    host,
    ...(ctx.hosts ? { hosts: ctx.hosts } : {}),
    previous: { startUtc: ctx.previous.startUtc, endUtc: ctx.previous.endUtc },
    brandName: ports.config.brandName,
    supportEmail: ports.config.supportEmail,
    ...(manageUrl ? { rescheduleUrl: manageUrl, cancelUrl: manageUrl } : {}),
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
        },
      })
      .catch((err) => console.error('[punctual] host reschedule mail failed to queue', err)),
  ])
}
