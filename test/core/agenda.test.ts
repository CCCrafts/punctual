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
  effectiveQuestions,
  pickDeclaredAnswers,
  validateAnswers,
} from '../../src/core/domain/booking-service.js'
import { confirmForm, type BookingPageData } from '../../src/http/pages/booking.js'
import { bookingConfirmationForHost, type BookingEmailContext } from '../../src/core/email-templates.js'

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
})
