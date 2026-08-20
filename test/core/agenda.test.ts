/**
 * The built-in agenda question — one closed loop across the answers
 * pipeline: form render, validation, filtering, calendar description, and
 * email rows all go through `effectiveQuestions`, so an answer can never be
 * collected that the other side won't display.
 */

import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import {
  AGENDA_QUESTION,
  answeredQuestions,
  effectiveQuestions,
  pickDeclaredAnswers,
  validateAnswers,
} from '../../src/core/domain/booking-service.js'
import { confirmForm, type BookingPageData } from '../../src/http/pages/booking.js'
import { bookingConfirmationForHost, type BookingEmailContext } from '../../src/core/email-templates.js'
import { buildIcs } from '../../src/core/ics.js'

const host: User = {
  id: 'u_host',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  tz: 'America/New_York',
  slug: 'grace',
  avatarKey: null,
  company: null,
  jobTitle: null,
  companyUrl: null,
  role: 'member',
  createdAt: 0,
}

function eventType(patch: Partial<EventType> = {}): EventType {
  return {
    id: 'et_1',
    ownerUserId: 'u_host',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: 'intro',
    title: 'Intro call',
    description: '',
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 60,
    maxHorizonDays: 60,
    maxPerDay: null,
    locationType: 'google_meet',
    locationValue: null,
    questions: [],
    active: true,
    createdAt: 0,
    ...patch,
  }
}

describe('effectiveQuestions', () => {
  it('appends the built-in agenda question after the host&apos;s own', () => {
    const own = { id: 'topic', label: 'Topic', type: 'text' as const, required: true }
    const qs = effectiveQuestions(eventType({ questions: [own] }))
    expect(qs).toEqual([own, AGENDA_QUESTION])
  })

  it('a host-declared question with the agenda id replaces the builtin entirely', () => {
    // The dashboard editor derives ids from labels — a "Agenda | textarea |
    // required" line produces exactly this id, which is the customisation
    // escape hatch.
    const own = { id: 'agenda', label: 'Agenda (required!)', type: 'textarea' as const, required: true }
    const qs = effectiveQuestions(eventType({ questions: [own] }))
    expect(qs).toEqual([own])
  })

  it('a host-declared question with the builtin\'s own wording also replaces it, not doubles it', () => {
    // A host typing the question out by hand — the far likelier path than
    // knowing the "Agenda" id escape hatch — gets a different slugified id
    // but the same label. That must not render the field twice.
    const own = {
      id: 'what-would-you-like-to-discuss',
      label: 'What would you like to discuss?',
      type: 'textarea' as const,
      required: true,
    }
    const qs = effectiveQuestions(eventType({ questions: [own] }))
    expect(qs).toEqual([own])
  })

  it('matches the builtin label regardless of case or extra whitespace', () => {
    const own = {
      id: 'q1',
      label: '  WHAT would  you like to discuss?  ',
      type: 'textarea' as const,
      required: false,
    }
    const qs = effectiveQuestions(eventType({ questions: [own] }))
    expect(qs).toEqual([own])
  })
})

describe('agenda answers through the pipeline', () => {
  it('pickDeclaredAnswers keeps an agenda answer', () => {
    expect(pickDeclaredAnswers(eventType(), { agenda: 'Pricing questions', evil: 'x' })).toEqual({
      agenda: 'Pricing questions',
    })
  })

  it('what gets validated is what gets stored — whitespace padding cannot smuggle an oversized answer past the cap', () => {
    // validateAnswers length-checks the TRIMMED value, so a short answer
    // padded with 200 KB of whitespace passes the 2000-char cap; if
    // pickDeclaredAnswers then kept the raw string, it would be persisted
    // and pushed into the queued email (Queues cap messages at 128 KB) and
    // the host's calendar event.
    const padded = { agenda: 'Roadmap' + ' '.repeat(200_000) }
    expect(validateAnswers(eventType(), padded)).toEqual({})
    expect(pickDeclaredAnswers(eventType(), padded)).toEqual({ agenda: 'Roadmap' })
  })

  it('drops an empty-after-trim optional answer instead of storing ""', () => {
    expect(pickDeclaredAnswers(eventType(), { agenda: '   ' })).toEqual({})
  })

  it('validateAnswers treats agenda as optional but still caps its length', () => {
    expect(validateAnswers(eventType(), {})).toEqual({})
    expect(validateAnswers(eventType(), { agenda: 'a'.repeat(2001) })).toHaveProperty('agenda')
  })

  it('confirmForm renders the agenda textarea', () => {
    const d: BookingPageData = {
      host,
      ownerSlug: 'grace',
      eventType: eventType(),
      month: '2026-09',
      daysWithSlots: new Map(),
      guestTimezone: 'UTC',
      baseUrl: 'https://example.test',
    }
    const html = confirmForm(d, Date.UTC(2026, 8, 10, 9, 0))
    expect(html).toContain('name="q_agenda"')
    expect(html).toContain(AGENDA_QUESTION.label)
    expect(html).toContain('(optional)')
  })

  it('the host confirmation email shows the agenda answer', () => {
    const booking: Booking = {
      id: 'bk_1',
      eventTypeId: 'et_1',
      hostUserId: 'u_host',
      hostUserIds: ['u_host'],
      guestName: 'Ada',
      guestEmail: 'ada@example.com',
      guestTimezone: 'UTC',
      startUtc: Date.UTC(2026, 8, 10, 9, 0),
      endUtc: Date.UTC(2026, 8, 10, 9, 30),
      localDate: '2026-09-10',
      status: 'confirmed',
      answers: { agenda: 'Quarterly roadmap review' },
      externalEventIds: {},
      rescheduleOf: null,
      rescheduledTo: null,
    } as unknown as Booking
    const ctx: BookingEmailContext = { booking, eventType: eventType(), host }
    const html = bookingConfirmationForHost(ctx).html
    expect(html).toContain(AGENDA_QUESTION.label)
    expect(html).toContain('Quarterly roadmap review')
  })

  it('a legacy answer stored under the builtin id still surfaces after a same-labeled question replaces it', () => {
    // The exact scenario the reviewers flagged: this booking predates the
    // host adding their own "What would you like to discuss?" question, so
    // its answer is keyed 'agenda' — a key effectiveQuestions no longer
    // returns for this event type. Without the fallback, reminder/cancel/
    // reschedule emails and the ICS description would silently drop it.
    const own = {
      id: 'what-would-you-like-to-discuss',
      label: 'What would you like to discuss?',
      type: 'textarea' as const,
      required: false,
    }
    const et = eventType({ questions: [own] })
    const answers = { agenda: 'Quarterly roadmap review' }

    const rows = answeredQuestions(et, answers)
    expect(rows).toEqual([{ question: AGENDA_QUESTION, value: 'Quarterly roadmap review' }])

    const booking: Booking = {
      id: 'bk_2',
      eventTypeId: 'et_1',
      hostUserId: 'u_host',
      hostUserIds: ['u_host'],
      guestName: 'Ada',
      guestEmail: 'ada@example.com',
      guestTimezone: 'UTC',
      startUtc: Date.UTC(2026, 8, 10, 9, 0),
      endUtc: Date.UTC(2026, 8, 10, 9, 30),
      localDate: '2026-09-10',
      status: 'confirmed',
      answers,
      externalEventIds: {},
      rescheduleOf: null,
      rescheduledTo: null,
    } as unknown as Booking

    const emailHtml = bookingConfirmationForHost({ booking, eventType: et, host }).html
    expect(emailHtml).toContain('Quarterly roadmap review')

    const ics = buildIcs({
      uid: 'bk_2@punctual',
      sequence: 0,
      method: 'REQUEST',
      booking,
      eventType: et,
      organizer: { email: host.email, name: host.name },
      attendees: [{ email: booking.guestEmail, name: booking.guestName }],
    })
    expect(ics).toContain('Quarterly roadmap review')
  })

  it('a live answer under the replacement id is not doubled by the legacy fallback', () => {
    const own = {
      id: 'what-would-you-like-to-discuss',
      label: 'What would you like to discuss?',
      type: 'textarea' as const,
      required: false,
    }
    const et = eventType({ questions: [own] })
    const rows = answeredQuestions(et, { 'what-would-you-like-to-discuss': 'New booking, own id' })
    expect(rows).toEqual([{ question: own, value: 'New booking, own id' }])
  })

  it('a submission under the stale builtin key is not lost when the host added a same-labeled question mid-fill', () => {
    // The guest's browser rendered the form before the host's edit, so it
    // still posts q_agenda; the event type it submits against already has
    // its own same-labeled question under a different id.
    const own = {
      id: 'what-would-you-like-to-discuss',
      label: 'What would you like to discuss?',
      type: 'textarea' as const,
      required: false,
    }
    const et = eventType({ questions: [own] })
    expect(pickDeclaredAnswers(et, { agenda: 'Stale-form roadmap question' })).toEqual({
      'what-would-you-like-to-discuss': 'Stale-form roadmap question',
    })
  })

  it('validateAnswers does not wrongly flag a required replacement as missing when only the stale key is present', () => {
    const own = {
      id: 'what-would-you-like-to-discuss',
      label: 'What would you like to discuss?',
      type: 'textarea' as const,
      required: true,
    }
    const et = eventType({ questions: [own] })
    expect(validateAnswers(et, { agenda: 'Stale-form roadmap question' })).toEqual({})
    expect(validateAnswers(et, {})).toHaveProperty('what-would-you-like-to-discuss')
  })

  it('a live submission under the current id is unaffected by the legacy fallback', () => {
    const own = {
      id: 'what-would-you-like-to-discuss',
      label: 'What would you like to discuss?',
      type: 'textarea' as const,
      required: false,
    }
    const et = eventType({ questions: [own] })
    expect(pickDeclaredAnswers(et, { 'what-would-you-like-to-discuss': 'Fresh-form answer' })).toEqual({
      'what-would-you-like-to-discuss': 'Fresh-form answer',
    })
  })
})
