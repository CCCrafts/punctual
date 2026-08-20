/**
 * The booking write path (ADR-0002).
 *
 * The ordering here is the design, so it is worth stating plainly:
 *
 *   1. resolve the event type and its hosts
 *   2. for round-robin, pick a host — by weight, then least-recently-booked
 *   3. re-validate the slot against fresh availability + freeBusy
 *   4. write the booking and its slot_locks in ONE batch
 *   5. only then talk to calendars, email and webhooks
 *
 * Step 4 is what makes double-booking impossible; everything before it is an
 * optimisation that turns a doomed write into an early, clean 409. Step 5 is
 * deliberately after the commit — an external calendar failing must not lose a
 * booking we already promised the guest.
 */

import type {
  Booking,
  CalendarConnection,
  EventType,
  EventTypeQuestion,
  Interval,
  TeamMember,
} from './types.js'
import type { BucketClaim } from '../../ports.js'
import { bookingFootprint, isSlotStillValid, type HostAvailabilityInput } from '../slots/engine.js'
import { intervalToBuckets } from '../slots/intervals.js'
import { localDateString } from '../time/zone.js'

export interface BookingRequest {
  eventType: EventType
  /** Every candidate host. Round-robin narrows this; collective uses all. */
  hosts: HostAvailabilityInput[]
  /**
   * How many hosts the CALLER intended to include.
   *
   * `hosts` contains only those that resolved — a member with no availability
   * row silently disappears upstream. For a collective booking that difference
   * is the whole meeting: committing with the survivors writes locks for some
   * hosts and leaves the dropped one's calendar unprotected and uninvited.
   */
  expectedHostCount?: number
  start: number
  guestName: string
  guestEmail: string
  guestTimezone: string
  answers: Record<string, string>
  now: number
  /** Provided by the caller; the DO already deduplicated by idempotency key. */
  bookingId: string
  manageTokenHash: string
  rescheduleOf?: string | null
  /** Round-robin ordering input: teamId + last-assigned times. */
  rrContext?: { teamId: string; members: TeamMember[]; lastAssignedAt: Map<string, number> }
}

export type BookingFailure =
  | 'slot_taken'
  | 'outside_availability'
  | 'policy'
  | 'no_eligible_host'

export type BookingResult =
  | { ok: true; booking: Booking; buckets: BucketClaim[] }
  | { ok: false; reason: BookingFailure; detail?: string }

/**
 * Choose the host for a round-robin booking.
 *
 * Weight first (a host with weight 2 should take roughly twice the load), then
 * least-recently-assigned as the tie-break, then id for determinism — without
 * that last tie-break two identical requests could pick different hosts, which
 * makes the behaviour untestable.
 *
 * Idle time MULTIPLIED by weight, then pick the maximum. A heavier host
 * accrues "due-ness" faster and is therefore chosen more often, which is what
 * distributes load proportionally.
 *
 * This was originally written as `idleMs / weight`, which inverts the
 * behaviour exactly: dividing makes a heavier host score LOWER, so a host
 * configured for triple load received a third of it. Caught by a simulation
 * over 40 sequential picks (weights 1 and 3 gave 30/10 instead of 10/30).
 */
export function pickRoundRobinHost(
  eligibleIds: string[],
  members: TeamMember[],
  lastAssignedAt: Map<string, number>,
  now: number,
): string | null {
  if (eligibleIds.length === 0) return null
  const byId = new Map(members.map((m) => [m.userId, m]))

  let best: string | null = null
  let bestScore = -Infinity
  for (const id of [...eligibleIds].sort()) {
    const weight = Math.max(1, byId.get(id)?.rrWeight ?? 1)
    const last = lastAssignedAt.get(id) ?? 0
    const idleMs = Math.max(0, now - last)
    const score = idleMs * weight
    if (score > bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}

/**
 * Did this slot fail because someone already has it, or because it was never
 * on offer?
 *
 * Both look identical to `isSlotStillValid`, because a confirmed booking
 * arrives as busy time — so the naive answer is always "outside availability",
 * which is actively misleading. A guest told "already taken" reloads the day;
 * an agent told "outside availability" may abandon the whole date range. The
 * distinction is cheap to compute and changes what the caller does next.
 */
export function failureReason(
  host: HostAvailabilityInput,
  et: EventType,
  start: number,
): 'slot_taken' | 'outside_availability' {
  const end = start + et.durationMinutes * 60_000
  const footprint = bookingFootprint(start, end, et)
  const collides = host.busy.some((b) => b.start < footprint.end && footprint.start < b.end)
  return collides ? 'slot_taken' : 'outside_availability'
}

/**
 * Build the booking and the buckets it must claim, after re-validating.
 *
 * Returns the intended write rather than performing it: the caller (inside the
 * host Durable Object) owns the D1 batch, so this stays pure and testable.
 */
export function prepareBooking(req: BookingRequest): BookingResult {
  const { eventType: et, now } = req
  const end = req.start + et.durationMinutes * 60_000

  if (!et.active) return { ok: false, reason: 'policy', detail: 'event type inactive' }
  if (req.hosts.length === 0) return { ok: false, reason: 'no_eligible_host' }

  // Which hosts must be free depends on the scheduling type.
  let participating: HostAvailabilityInput[]
  if (et.schedulingType === 'collective') {
    // All of them — and if any one fails, the whole booking fails. That
    // includes hosts that failed to resolve at all, which would otherwise
    // vanish from the set and be silently excluded from their own meeting.
    if (req.expectedHostCount != null && req.hosts.length < req.expectedHostCount) {
      return {
        ok: false,
        reason: 'outside_availability',
        detail: 'one or more hosts have no availability configured',
      }
    }
    participating = req.hosts
    for (const h of participating) {
      if (!isSlotStillValid(h, et, req.start, now)) {
        return { ok: false, reason: failureReason(h, et, req.start), detail: h.hostUserId }
      }
    }
  } else if (et.schedulingType === 'round_robin') {
    const eligible = req.hosts.filter((h) => isSlotStillValid(h, et, req.start, now))
    if (eligible.length === 0) {
      // Round-robin: only report "taken" if EVERY candidate is busy. If any
      // host was merely unavailable, the slot was never really on offer.
      const allBusy = req.hosts.every((h) => failureReason(h, et, req.start) === 'slot_taken')
      return { ok: false, reason: allBusy ? 'slot_taken' : 'outside_availability' }
    }
    const chosen = pickRoundRobinHost(
      eligible.map((h) => h.hostUserId),
      req.rrContext?.members ?? [],
      req.rrContext?.lastAssignedAt ?? new Map(),
      now,
    )
    const host = eligible.find((h) => h.hostUserId === chosen)
    if (!host) return { ok: false, reason: 'no_eligible_host' }
    participating = [host]
  } else {
    const host = req.hosts[0]!
    if (!isSlotStillValid(host, et, req.start, now)) {
      return { ok: false, reason: failureReason(host, et, req.start) }
    }
    participating = [host]
  }

  // The footprint is the meeting plus its buffers — the SAME definition the
  // slot generator used (ADR-0004 §4). Generator and arbiter agreeing is what
  // stops us offering slots that 409 on click.
  const footprint = bookingFootprint(req.start, end, et)
  const bucketStarts = intervalToBuckets(footprint)

  const buckets: BucketClaim[] = []
  for (const h of participating) {
    for (const b of bucketStarts) buckets.push({ hostUserId: h.hostUserId, bucketStart: b })
  }

  const primary = participating[0]!
  const booking: Booking = {
    id: req.bookingId,
    eventTypeId: et.id,
    hostUserId: primary.hostUserId,
    hostUserIds: participating.map((h) => h.hostUserId),
    guestName: req.guestName,
    guestEmail: req.guestEmail.toLowerCase(),
    guestTimezone: req.guestTimezone,
    startUtc: req.start,
    endUtc: end,
    // Stamped in the PRIMARY host's timezone, because that is whose per-day
    // cap it counts against.
    localDate: localDateString(req.start, primary.availability.timezone),
    status: 'confirmed',
    answers: req.answers,
    externalEventIds: {},
    rescheduleOf: req.rescheduleOf ?? null,
    rescheduledTo: null,
    manageTokenHash: req.manageTokenHash,
    cancelledAt: null,
    createdAt: now,
  }

  return { ok: true, booking, buckets }
}

/**
 * Merge everything that makes a host busy, for the slot engine.
 *
 * Own bookings arrive as buckets (already buffer-expanded by construction);
 * external freeBusy arrives raw and is NOT expanded, because buffers belong to
 * the event type being booked, not to the existing event.
 */
export function combineBusy(
  ownBuckets: number[],
  holdBuckets: number[],
  external: Interval[],
): Interval[] {
  const out: Interval[] = external.slice()
  for (const b of ownBuckets) out.push({ start: b, end: b + 5 * 60_000 })
  for (const b of holdBuckets) out.push({ start: b, end: b + 5 * 60_000 })
  return out
}

/**
 * Validate guest-supplied answers against the event type's questions.
 *
 * Returns field-level errors rather than a boolean so the form can show them
 * inline; a booking page that just says "invalid" is a booking page people
 * abandon.
 */
/**
 * The one question every booking form asks without the host configuring
 * anything: what the meeting is about. Optional on purpose — a required
 * agenda is a form guests abandon.
 */
export const AGENDA_QUESTION: EventTypeQuestion = {
  id: 'agenda',
  label: 'What would you like to discuss?',
  type: 'textarea',
  required: false,
}

function normalizeQuestionLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ')
}

const AGENDA_LABEL_NORMALIZED = normalizeQuestionLabel(AGENDA_QUESTION.label)

/**
 * The questions a booking form actually asks: the host's own, plus the
 * built-in agenda question — unless the host already declares one that means
 * the same thing. That's either the id the dashboard editor derives from a
 * literal "Agenda | ..." line (the documented escape hatch: their label,
 * their required flag, entirely replaces the builtin), OR a question whose
 * label is the builtin's own wording ("What would you like to discuss?"),
 * which a host reaches just as easily by typing it in the questions editor
 * without knowing the "Agenda" keyword. Matching only by id let that second,
 * far more likely path double up: the host's copy AND the appended builtin,
 * rendering the identical field twice on the booking form. Every consumer of
 * the answers pipeline (form render, validation, calendar description,
 * emails, MCP listing) goes through this, so an answer can never be
 * collected that the other side won't display.
 */
export function effectiveQuestions(et: EventType): EventTypeQuestion[] {
  const hasOwnAgenda = et.questions.some(
    (q) => q.id === AGENDA_QUESTION.id || normalizeQuestionLabel(q.label) === AGENDA_LABEL_NORMALIZED,
  )
  return hasOwnAgenda ? et.questions : [...et.questions, AGENDA_QUESTION]
}

/**
 * A submitted answer for `q`, tolerating one specific staleness: the guest's
 * form was rendered before the host edited the event type to add a
 * same-labeled question, so the guest's browser still posts under the
 * builtin's `q_agenda` field while `q` (today's effective question for that
 * same wording) has a different id and gets nothing at its own key. Without
 * this, the answer the guest actually typed is silently dropped rather than
 * stored — same failure shape as the stale-render case `answeredQuestions`
 * covers on the read side, just triggered by a host edit between page load
 * and submit instead of one before the booking existed.
 */
function submittedAnswerFor(q: EventTypeQuestion, answers: Record<string, string>): string | undefined {
  const direct = answers[q.id]
  if (direct !== undefined) return direct
  if (q.id !== AGENDA_QUESTION.id && normalizeQuestionLabel(q.label) === AGENDA_LABEL_NORMALIZED) {
    return answers[AGENDA_QUESTION.id]
  }
  return undefined
}

export function pickDeclaredAnswers(
  et: EventType,
  answers: Record<string, string>,
): Record<string, string> {
  // Only keys the event type actually declares (plus the builtin above).
  // Anything else bypasses the required/select checks and the length cap
  // below, and `buildDescription` writes every key into the event on the
  // host's real calendar — so an unauthenticated guest could otherwise put
  // arbitrary text of arbitrary size there.
  const out: Record<string, string> = {}
  for (const q of effectiveQuestions(et)) {
    const v = submittedAnswerFor(q, answers)
    // Trimmed HERE, not just in validation: `validateAnswers` length-checks
    // the trimmed value, so an answer of a few words padded with 200 KB of
    // whitespace would pass the 2000-char cap and then be persisted raw —
    // into D1, the queued email (Queues cap messages at 128 KB), and the
    // host's calendar event. What gets validated must be what gets stored.
    // Empty-after-trim optional answers are dropped rather than stored as
    // "", so emails/ICS never render a labelled blank row.
    if (v !== undefined && v.trim() !== '') out[q.id] = v.trim()
  }
  return out
}

/**
 * Every stored answer worth showing back — form questions currently in
 * effect, PLUS a fallback for the one case those can silently drop: a
 * booking made while the builtin agenda question was still active for this
 * event type, before the host's own same-labeled question started
 * suppressing it (see `effectiveQuestions`). That booking's answer is
 * stored under the builtin's id, which is no longer in the effective list,
 * so without this it would vanish from every reminder, cancellation, and
 * reschedule email — the guest's answer still exists in D1, the host would
 * just never see it again. Only reached when the effective list doesn't
 * already carry that id, so a live "Agenda" replacement question renders
 * its own value, never the stale one twice.
 */
export function answeredQuestions(
  et: EventType,
  answers: Record<string, string>,
): Array<{ question: EventTypeQuestion; value: string }> {
  const questions = effectiveQuestions(et)
  const out: Array<{ question: EventTypeQuestion; value: string }> = []
  for (const q of questions) {
    const value = answers[q.id]
    if (value !== undefined && value.trim() !== '') out.push({ question: q, value: value.trim() })
  }
  if (!questions.some((q) => q.id === AGENDA_QUESTION.id)) {
    const legacy = answers[AGENDA_QUESTION.id]
    if (legacy !== undefined && legacy.trim() !== '') out.push({ question: AGENDA_QUESTION, value: legacy.trim() })
  }
  return out
}

export function validateAnswers(
  et: EventType,
  answers: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const q of effectiveQuestions(et)) {
    const v = (submittedAnswerFor(q, answers) ?? '').trim()
    if (q.required && v === '') {
      errors[q.id] = 'This field is required'
      continue
    }
    if (v !== '' && q.type === 'select' && q.options && !q.options.includes(v)) {
      errors[q.id] = 'Not one of the available options'
    }
    if (v.length > 2000) errors[q.id] = 'Too long (max 2000 characters)'
  }
  return errors
}

/** RFC 5322-ish. Deliberately permissive: rejecting valid addresses loses bookings. */
export function isValidEmail(email: string): boolean {
  if (email.length > 254) return false
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)
}

/**
 * Which connections to read for busy-ness, and which to write the event to.
 * A connection needing reconnection is skipped for writes but still read —
 * stale busy data is better than none while the host fixes their connection.
 */
export function partitionConnections(connections: CalendarConnection[]): {
  read: CalendarConnection[]
  write: CalendarConnection[]
} {
  return {
    // Microsoft's `getBusy` reads the whole mailbox by default
    // (providerAccountEmail) and only narrows to `calendarIdsRead` when it's
    // non-empty — see adapters/microsoft/provider.ts. Google has no such
    // fallback: an empty `calendarIdsRead` there genuinely means nothing was
    // selected, so excluding it is correct. Filtering Microsoft out here too
    // meant `getBusy` was never even called for it, silently disabling
    // conflict checking rather than fixing which identifier it queried.
    read: connections.filter((c) => c.provider === 'microsoft' || c.calendarIdsRead.length > 0),
    write: connections.filter((c) => c.calendarIdWrite && c.syncStatus === 'ok'),
  }
}
