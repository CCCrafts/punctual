/**
 * iCalendar (.ics) generation — RFC 5545, with the scheduling semantics of
 * RFC 5546 (iTIP).
 *
 * Pure. No I/O, no clock: `DTSTAMP` is derived from the booking's own
 * timestamps rather than read from a clock, so the same booking always renders
 * byte-identical output. That is what makes this testable and what makes a
 * retried queue job produce an .ics a client recognises as the same object.
 *
 * Three things here are load-bearing and each of them breaks calendars quietly
 * rather than loudly when they are wrong:
 *
 *   1. UID + SEQUENCE decide UPDATE vs DUPLICATE. See `icsUidForBooking`.
 *   2. Content lines are folded at 75 OCTETS, not characters (RFC 5545 §3.1).
 *      A Cyrillic or emoji title is roughly two to four times longer in octets
 *      than in characters, so a character-based implementation emits lines that
 *      Outlook and older Exchange reject outright.
 *   3. TEXT values are escaped per §3.3.11; URI values are NOT. Escaping a URL
 *      turns `https://x/a,b` into `https://x/a\,b`, which some clients follow
 *      literally.
 */

import type { Booking, EventType } from './domain/types.js'
import { answeredQuestions } from './domain/booking-service.js'

export type IcsMethod = 'REQUEST' | 'CANCEL'
export type IcsStatus = 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE'

export interface IcsPerson {
  name: string
  email: string
}

export interface IcsInput {
  /** Stable across the whole reschedule chain — see `icsUidForBooking`. */
  uid: string
  /** Monotonically increasing per UID — see `icsSequenceForBooking`. */
  sequence: number
  method: IcsMethod
  booking: Booking
  eventType: EventType
  organizer: IcsPerson
  attendees: IcsPerson[]
  /** Defaults from `method`: REQUEST → CONFIRMED, CANCEL → CANCELLED. */
  status?: IcsStatus
  /** The manage/booking page. Emitted as a URI value, so it is never escaped. */
  url?: string
  /**
   * Epoch ms for DTSTAMP. Defaults to `cancelledAt` for a cancellation and
   * `createdAt` otherwise — both already on the booking, which keeps the
   * function pure and the output reproducible.
   */
  dtstamp?: number
  /** Replaces the generated body of DESCRIPTION when supplied. */
  description?: string
}

const PRODID = '-//Punctual//Punctual Scheduling Engine//EN'

/** RFC 5545 §3.1: 75 octets excluding the CRLF. */
const MAX_OCTETS = 75

// ---------------------------------------------------------------------------
// UID and SEQUENCE — the part everyone gets wrong
// ---------------------------------------------------------------------------

/**
 * A stable UID from a booking id.
 *
 * RFC 5545 §3.8.4.7 wants a globally unique value; the conventional shape is
 * `<opaque>@<domain>`. The opaque half is our booking id, which is already
 * unguessable, so the UID leaks nothing a guest with the invite does not have.
 */
export function icsUid(bookingId: string, domain = 'punctual'): string {
  return `${bookingId}@${domain}`
}

/** Only what UID/SEQUENCE resolution needs, so callers can pass partial rows. */
export interface RescheduleLink {
  id: string
  rescheduleOf: string | null
}

/**
 * Walk a reschedule chain back to the booking that started it.
 *
 * `rescheduleOf` points at the immediate predecessor only, so for A → B → C
 * resolving one hop from C yields B — and a UID built on B would make every
 * client create a SECOND event instead of moving the first. `chain` is
 * REQUIRED (not optional): a two-hop reschedule needs the full lineage to
 * resolve correctly, and an optional parameter let call sites silently fall
 * back to the one-hop answer by omission — which is exactly wrong on the
 * second reschedule of a booking. A caller that genuinely has no lineage
 * (a brand-new booking, known to have no `rescheduleOf`) passes `new Map()`
 * explicitly, which is a correct and honest answer for a root booking.
 *
 * Cycle-guarded: a corrupt chain must degrade to a duplicate event, never to a
 * hung queue consumer.
 */
export function icsRootBookingId(
  booking: RescheduleLink,
  chain: ReadonlyMap<string, RescheduleLink>,
): string {
  let current = booking
  const seen = new Set<string>([current.id])
  while (current.rescheduleOf) {
    const previous = chain.get(current.rescheduleOf)
    if (!previous) return current.rescheduleOf
    if (seen.has(previous.id)) return current.id
    seen.add(previous.id)
    current = previous
  }
  return current.id
}

/**
 * The UID to use for a booking, honouring its reschedule chain.
 *
 * THE RULE: same UID + higher SEQUENCE = the client MOVES the existing event.
 * A new UID = a second event in the calendar and the old one left behind on the
 * old date. A reschedule therefore MUST reuse the ORIGINAL booking's id here
 * and MUST bump SEQUENCE; doing either one without the other is what produces
 * the classic "I now have two meetings" support ticket.
 *
 * `chain` is required — see `icsRootBookingId`.
 */
export function icsUidForBooking(
  booking: RescheduleLink,
  chain: ReadonlyMap<string, RescheduleLink>,
  domain = 'punctual',
): string {
  return icsUid(icsRootBookingId(booking, chain), domain)
}

/**
 * The SEQUENCE for a booking: how many reschedules deep it is.
 *
 * RFC 5545 §3.8.7.4 — SEQUENCE starts at 0 and the organiser increments it on
 * every significant change (a moved DTSTART is the definition of significant).
 * Chain depth is a perfect fit because it is derived from stored state rather
 * than from a counter we would have to remember to increment.
 *
 * Cancellations pass `cancelled: true`, which adds one. RFC 5546 §3.2.5 wants
 * the CANCEL to carry a SEQUENCE no lower than the REQUEST it revokes; going
 * strictly higher removes any doubt for clients that compare with `>`.
 *
 * `chain` is required for the same reason as in `icsRootBookingId`: without
 * the full lineage a two-hop booking's depth under-counts by one, which means
 * its SEQUENCE collides with the hop before it instead of exceeding it.
 *
 * IMPORTANT: `cancelled: true` must only ever be passed for a booking's OWN,
 * terminal cancellation — never to compute a CANCEL for the booking that a
 * *later* reschedule superseded. Two independent bookings each computing
 * their own depth-based SEQUENCE have no way to see each other, so a
 * superseded leg's "CANCEL, +1" and its replacement's "REQUEST" can land on
 * the same SEQUENCE number for the same UID — see `icsCancelSuppressed`,
 * which is why a superseded leg must never reach this function with
 * `cancelled: true` at all.
 */
export function icsSequenceForBooking(
  booking: RescheduleLink,
  chain: ReadonlyMap<string, RescheduleLink>,
  cancelled = false,
): number {
  let depth = 0
  let current = booking
  const seen = new Set<string>([current.id])
  while (current.rescheduleOf) {
    depth += 1
    const previous = chain.get(current.rescheduleOf)
    if (!previous || seen.has(previous.id)) break
    seen.add(previous.id)
    current = previous
  }
  return depth + (cancelled ? 1 : 0)
}

/**
 * Whether a CANCEL .ics must be suppressed for this booking.
 *
 * True exactly when the booking has itself been superseded by a later
 * reschedule (`rescheduledTo` set) rather than genuinely, terminally
 * cancelled. `buildIcs`'s own docstring states the design: a reschedule is a
 * re-REQUEST of the existing UID, never a CANCEL followed by a fresh invite —
 * "the CANCEL half tends to arrive first and some clients then drop the
 * replacement". `icsSequenceForBooking` cannot make that safe on its own: it
 * only sees ITS OWN booking's chain depth, so a CANCEL computed for the
 * superseded leg and a REQUEST computed for its replacement can both land on
 * the same SEQUENCE for the same UID (both being one hop removed from the
 * same predecessor). Suppressing the CANCEL entirely for a superseded leg —
 * rather than trying to out-guess its replacement's SEQUENCE — is what keeps
 * the guest from silently losing the meeting.
 */
export function icsCancelSuppressed(booking: { rescheduledTo: string | null }): boolean {
  return booking.rescheduledTo !== null
}

// ---------------------------------------------------------------------------
// Escaping, folding, formatting
// ---------------------------------------------------------------------------

/**
 * Escape a TEXT value per RFC 5545 §3.3.11.
 *
 * Backslash first — escaping it after the others would double-escape the
 * backslashes those others just introduced. COLON is deliberately absent: the
 * grammar only special-cases it inside parameter values, and clients that see
 * `\:` render the backslash.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // Remaining C0 controls have no representation in a content line at all
    // (CR and LF are already gone, folded into the two-character sequence \n).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
}

/**
 * Escape a parameter value per RFC 5545 §3.2.
 *
 * Parameter values use DQUOTE, not backslashes: a value containing `:`, `;` or
 * `,` must be quoted, and a quoted value cannot itself contain a DQUOTE — so
 * the quote is dropped rather than escaped. This matters because CN carries a
 * user-supplied display name; `CN=Smith, John` unquoted would be parsed as a
 * malformed second parameter.
 */
export function escapeParam(value: string): string {
  const clean = value.replace(/["\u0000-\u001F\u007F]/gu, '').trim()
  return /[:;,]/.test(clean) ? `"${clean}"` : clean
}

function utf8Length(codePoint: string): number {
  const cp = codePoint.codePointAt(0) ?? 0
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp < 0x10000) return 3
  return 4
}

/**
 * Fold one content line to 75 octets, RFC 5545 §3.1.
 *
 * Counting octets rather than characters is the whole point; iterating with
 * `for...of` gives code points, so a surrogate pair (any emoji) is never split
 * across the break. The continuation's leading space is itself part of the 75
 * octets, hence the counter starting at 1 after a break.
 */
export function foldLine(line: string): string {
  const out: string[] = []
  let current = ''
  let octets = 0
  for (const ch of line) {
    const width = utf8Length(ch)
    if (octets + width > MAX_OCTETS) {
      out.push(current)
      current = ''
      octets = 1 // the single space that begins every continuation line
    }
    current += ch
    octets += width
  }
  out.push(current)
  return out.join('\r\n ')
}

/** `YYYYMMDDTHHMMSSZ` — RFC 5545 §3.3.5 form 2, UTC. */
export function icsDateTimeUtc(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/** Human-readable location, shared with the email templates so the two agree. */
export function describeLocation(et: EventType): string {
  switch (et.locationType) {
    case 'google_meet':
      return et.locationValue ?? 'Google Meet (link in the calendar invite)'
    case 'custom_link':
      return et.locationValue ?? 'Online'
    case 'phone':
      return et.locationValue ? `Phone: ${et.locationValue}` : 'Phone call'
    case 'in_person':
      return et.locationValue ?? 'In person'
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** Answers rendered as `Label: value`, in the order the questions are defined. */
function describeAnswers(et: EventType, booking: Booking): string[] {
  return answeredQuestions(et, booking.answers).map(({ question, value }) => `${question.label}: ${value}`)
}

function defaultDescription(booking: Booking, et: EventType): string {
  const parts: string[] = []
  if (et.description.trim() !== '') parts.push(et.description.trim())
  parts.push(`Guest: ${booking.guestName} <${booking.guestEmail}>`)
  const answers = describeAnswers(et, booking)
  if (answers.length > 0) parts.push(answers.join('\n'))
  return parts.join('\n\n')
}

/**
 * Build a complete VCALENDAR containing one VEVENT.
 *
 * METHOD is the iTIP verb (RFC 5546 §3.2): REQUEST both for a new booking and
 * for a reschedule — a reschedule is a re-REQUEST of the same UID, not a CANCEL
 * followed by a fresh invite, because the CANCEL half tends to arrive first and
 * some clients then drop the replacement.
 */
export function buildIcs(input: IcsInput): string {
  const { booking, eventType: et, method } = input
  const status: IcsStatus = input.status ?? (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED')
  const dtstamp =
    input.dtstamp ??
    (method === 'CANCEL' ? booking.cancelledAt ?? booking.createdAt : booking.createdAt)

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(PRODID)}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${escapeText(input.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
    `DTSTAMP:${icsDateTimeUtc(dtstamp)}`,
    `DTSTART:${icsDateTimeUtc(booking.startUtc)}`,
    `DTEND:${icsDateTimeUtc(booking.endUtc)}`,
    `SUMMARY:${escapeText(et.title)}`,
    `DESCRIPTION:${escapeText(input.description ?? defaultDescription(booking, et))}`,
    `LOCATION:${escapeText(describeLocation(et))}`,
    `STATUS:${status}`,
    // Cancelled time no longer blocks the attendee's calendar.
    `TRANSP:${status === 'CANCELLED' ? 'TRANSPARENT' : 'OPAQUE'}`,
    `ORGANIZER;CN=${escapeParam(input.organizer.name)}:mailto:${input.organizer.email}`,
  ]

  for (const a of input.attendees) {
    // RSVP=TRUE asks the client to offer accept/decline; PARTSTAT stays
    // NEEDS-ACTION because the guest booked with us, not with the host's
    // calendar, and claiming ACCEPTED here would suppress that prompt.
    lines.push(
      `ATTENDEE;CN=${escapeParam(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
    )
  }

  // URI value type (§3.3.13): emitted verbatim. Escaping it would corrupt any
  // URL containing a comma or semicolon.
  if (input.url) lines.push(`URL:${input.url}`)

  lines.push('END:VEVENT', 'END:VCALENDAR')

  // Trailing CRLF included: a content line is terminated by CRLF, including
  // the last one.
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

/**
 * Content types for the attachment. The `method` parameter has to match the
 * METHOD inside the document: Outlook reads the MIME parameter, not the body,
 * when deciding whether an attachment is an invitation or a cancellation.
 */
export const ICS_CONTENT_TYPE = 'text/calendar; charset=utf-8; method=REQUEST'
export const ICS_CANCEL_CONTENT_TYPE = 'text/calendar; charset=utf-8; method=CANCEL'
