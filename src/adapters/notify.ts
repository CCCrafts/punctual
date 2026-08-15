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
  bookingConfirmationForGuest,
  bookingConfirmationForHost,
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

  const attachments = ics
    ? [
        {
          filename: 'invite.ics',
          content: base64(ics),
          contentType: 'text/calendar; method=REQUEST',
        },
      ]
    : undefined

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

  await ports.queue
    .sendBatch([
      {
        kind: 'email',
        message: {
          to: booking.guestEmail,
          toName: booking.guestName,
          subject: guest.subject,
          html: guest.html,
          text: guest.text,
          ...(attachments ? { attachments } : {}),
        },
      },
      {
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
      },
    ])
    .catch((err) => {
      console.error('[punctual] queueing confirmation emails failed', err)
    })
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
