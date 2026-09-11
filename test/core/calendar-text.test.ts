import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import { calendarDescription, calendarTitle, guestCompany, participantsFor } from '../../src/core/domain/calendar-text.js'

const START = Date.UTC(2026, 8, 14, 9, 0, 0)

function eventType(patch: Partial<EventType> = {}): EventType {
  return {
    id: 'et_1',
    ownerUserId: 'u_serge',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: 'intro',
    title: 'Intro call',
    description: 'A short chat about your scheduling.',
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
    scheduleId: null,
    ...patch,
  }
}

function booking(patch: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1',
    eventTypeId: 'et_1',
    hostUserId: 'u_serge',
    hostUserIds: ['u_serge'],
    guestName: 'Jane Doe',
    guestEmail: 'jane@acme.com',
    guestTimezone: 'Europe/Kyiv',
    startUtc: START,
    endUtc: START + 30 * 60_000,
    localDate: '2026-09-14',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    conferenceUrl: null,
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: 'hash',
    cancelledAt: null,
    createdAt: START - 86_400_000,
    ...patch,
  }
}

function user(patch: Partial<User>): User {
  return {
    id: 'u_x',
    email: 'x@example.com',
    name: 'X',
    tz: 'UTC',
    slug: 'x',
    avatarKey: null,
    company: null,
    jobTitle: null,
    companyUrl: null,
    role: 'member',
    createdAt: 0,
    ...patch,
  }
}

const serge = user({ id: 'u_serge', email: 'serge@cccrafts.ai', name: 'Serge Bulaev', slug: 'serge', company: 'CCCrafts', jobTitle: 'CEO' })
const alice = user({ id: 'u_alice', email: 'alice@cccrafts.ai', name: 'Alice Ivanova', slug: 'alice', company: 'CCCrafts' })
const bob = user({ id: 'u_bob', email: 'bob@partner.io', name: 'Bob Chen', slug: 'bob', company: 'Partner' })

describe("the guest's company", () => {
  it('is what they answered to a question that IS the company, whatever the language of the label', () => {
    for (const label of ['Company', 'Company:', 'Your organisation', 'Organization name', 'Employer?', 'Компанія', 'Ваша компания', 'Организация', 'Название компании']) {
      const et = eventType({ questions: [{ id: 'q1', label, type: 'text', required: false }] })
      expect(guestCompany(et, { guestEmail: 'jane@gmail.com', answers: { q1: ' Acme\n Inc ' } }), label).toBe('Acme Inc')
    }
  })

  it('ignores a question that merely mentions the company, and any textarea (caught by review)', () => {
    for (const label of ['Company size', 'How did you hear about our company?', 'Company website', 'Which firm referred you?']) {
      const et = eventType({ questions: [{ id: 'q1', label, type: 'select', required: false, options: ['11-50'] }] })
      expect(guestCompany(et, { guestEmail: 'jane@acme.com', answers: { q1: '11-50' } }), label).toBe('acme.com')
    }
    const essay = eventType({ questions: [{ id: 'q1', label: 'Company', type: 'textarea', required: false }] })
    expect(guestCompany(essay, { guestEmail: 'jane@acme.com', answers: { q1: 'We are a 40-person\nshop in Kyiv' } })).toBe('acme.com')
  })

  it('falls back to a work email domain, never to a mailbox provider', () => {
    const et = eventType()
    expect(guestCompany(et, { guestEmail: 'jane@acme.com', answers: {} })).toBe('acme.com')
    expect(guestCompany(et, { guestEmail: 'Jane@Sales.Acme.co.uk', answers: {} })).toBe('sales.acme.co.uk')
    for (const email of ['j@gmail.com', 'j@yahoo.co.uk', 'j@outlook.com', 'j@icloud.com', 'j@mail.ru', 'j@ukr.net', 'j@proton.me', 'j@i.ua', 'j@example.com']) {
      expect(guestCompany(et, { guestEmail: email, answers: {} }), email).toBeNull()
    }
    expect(guestCompany(et, { guestEmail: 'nonsense', answers: {} })).toBeNull()
  })

  it('an empty answer to the company question does not hide the domain', () => {
    const et = eventType({ questions: [{ id: 'q1', label: 'Company', type: 'text', required: false }] })
    expect(guestCompany(et, { guestEmail: 'jane@acme.com', answers: { q1: '  ' } })).toBe('acme.com')
  })
})

describe('the calendar title', () => {
  it('names the guest and the host with their companies', () => {
    const p = participantsFor(eventType(), booking(), [{ user: serge, optional: false }])
    expect(calendarTitle(eventType(), p)).toBe('Intro call: Jane Doe (acme.com) with Serge Bulaev (CCCrafts)')
  })

  it('names hosts of one company together, hosts of different companies each with theirs, and leaves optional hosts out', () => {
    const et = eventType({ ownerUserId: null, ownerTeamId: 'team_1', schedulingType: 'collective' })
    const same = participantsFor(et, booking({ hostUserIds: ['u_serge', 'u_alice'] }), [
      { user: serge, optional: false },
      { user: alice, optional: false },
    ])
    expect(calendarTitle(et, same)).toBe('Intro call: Jane Doe (acme.com) with Serge Bulaev and Alice Ivanova (CCCrafts)')
    const mixed = participantsFor(et, booking(), [
      { user: serge, optional: false },
      { user: bob, optional: false },
      { user: alice, optional: true },
    ])
    expect(calendarTitle(et, mixed)).toBe('Intro call: Jane Doe (acme.com) with Serge Bulaev (CCCrafts) and Bob Chen (Partner)')
  })

  it('copes with a guest who gave no name and a host with no company', () => {
    const p = participantsFor(eventType(), booking({ guestName: '  ', guestEmail: 'jane@gmail.com' }), [{ user: user({ name: 'Solo Host', email: 'solo@gmail.com' }), optional: false }])
    expect(calendarTitle(eventType(), p)).toBe('Intro call: jane@gmail.com with Solo Host')
  })
})

describe('the calendar description', () => {
  it('lists every participant with title, company, email and role, then the answers by label', () => {
    const et = eventType({
      ownerUserId: null,
      ownerTeamId: 'team_1',
      schedulingType: 'collective',
      questions: [
        { id: 'q1', label: 'Company', type: 'text', required: false },
        { id: 'q2', label: 'What should we cover?', type: 'textarea', required: false },
      ],
    })
    const bk = booking({ answers: { q1: 'Acme Inc', q2: 'Pricing and rollout' } })
    const p = participantsFor(et, bk, [
      { user: serge, optional: false },
      { user: alice, optional: true },
    ])
    expect(calendarDescription(et, bk, p)).toBe(
      [
        'A short chat about your scheduling.',
        '',
        'Participants',
        '• Jane Doe — Acme Inc — jane@acme.com (guest)',
        '• Serge Bulaev — CEO, CCCrafts — serge@cccrafts.ai (host)',
        '• Alice Ivanova — CCCrafts — alice@cccrafts.ai (optional host)',
        '',
        'Company: Acme Inc',
        'What should we cover?: Pricing and rollout',
      ].join('\n'),
    )
  })

  it('has no empty blocks when the event type has no description and nothing was asked', () => {
    const et = eventType({ description: '' })
    const p = participantsFor(et, booking(), [{ user: serge, optional: false }])
    expect(calendarDescription(et, booking(), p)).toBe(
      ['Participants', '• Jane Doe — acme.com — jane@acme.com (guest)', '• Serge Bulaev — CEO, CCCrafts — serge@cccrafts.ai (host)'].join('\n'),
    )
  })
})
