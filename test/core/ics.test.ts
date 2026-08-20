import { describe, expect, it } from 'vitest'
import type { Booking, EventType } from '../../src/core/domain/types.js'
import {
  buildIcs,
  escapeParam,
  escapeText,
  foldLine,
  icsCancelSuppressed,
  icsDateTimeUtc,
  icsRootBookingId,
  icsSequenceForBooking,
  icsUid,
  icsUidForBooking,
  type IcsInput,
  type RescheduleLink,
} from '../../src/core/ics.js'

const NO_CHAIN = new Map<string, RescheduleLink>()

const START = Date.UTC(2026, 7, 14, 9, 0, 0)

function eventType(patch: Partial<EventType> = {}): EventType {
  return {
    id: 'et_1',
    ownerUserId: 'u_host',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: 'intro',
    title: 'Intro call',
    description: 'A short chat.',
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
    hostUserId: 'u_host',
    hostUserIds: ['u_host'],
    guestName: 'Ada Lovelace',
    guestEmail: 'ada@example.com',
    guestTimezone: 'Europe/Kyiv',
    startUtc: START,
    endUtc: START + 30 * 60_000,
    localDate: '2026-08-14',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: 'hash',
    cancelledAt: null,
    createdAt: Date.UTC(2026, 7, 10, 12, 0, 0),
    ...patch,
  }
}

function ics(
  patch: { booking?: Booking; eventType?: EventType } = {},
  overrides: Partial<IcsInput> = {},
): string {
  return buildIcs({
    uid: icsUid('bk_1'),
    sequence: 0,
    method: 'REQUEST',
    booking: patch.booking ?? booking(),
    eventType: patch.eventType ?? eventType(),
    organizer: { name: 'Grace Hopper', email: 'grace@example.com' },
    attendees: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
    ...overrides,
  })
}

const octets = (s: string): number => new TextEncoder().encode(s).length

/** Split into content lines, dropping the trailing empty from the final CRLF. */
function contentLines(doc: string): string[] {
  const parts = doc.split('\r\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** RFC 5545 §3.1 unfolding: remove every CRLF immediately followed by a space. */
function unfold(doc: string): string {
  return doc.replace(/\r\n /g, '')
}

function propertyValue(doc: string, name: string): string | undefined {
  const line = contentLines(unfold(doc)).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`))
  if (!line) return undefined
  return line.slice(line.indexOf(':') + 1)
}

// ---------------------------------------------------------------------------

describe('foldLine — 75 OCTETS, not characters', () => {
  it('leaves a line of exactly 75 octets alone', () => {
    const line = `SUMMARY:${'a'.repeat(75 - 'SUMMARY:'.length)}`
    expect(octets(line)).toBe(75)
    expect(foldLine(line)).toBe(line)
  })

  it('folds at 76 octets, and the continuation carries the leading space', () => {
    const line = `SUMMARY:${'a'.repeat(76 - 'SUMMARY:'.length)}`
    const folded = foldLine(line)
    const parts = folded.split('\r\n')
    expect(parts).toHaveLength(2)
    expect(octets(parts[0]!)).toBe(75)
    expect(parts[1]).toBe(' a')
    expect(unfold(folded)).toBe(line)
  })

  it('counts Cyrillic as two octets per character', () => {
    // 40 Cyrillic characters = 80 octets, but only 40 JS characters. A
    // character-based fold would emit this as one 88-octet line.
    const line = `SUMMARY:${'ж'.repeat(40)}`
    expect(line.length).toBeLessThan(75)
    expect(octets(line)).toBeGreaterThan(75)
    const folded = foldLine(line)
    for (const part of folded.split('\r\n')) expect(octets(part)).toBeLessThanOrEqual(75)
    expect(unfold(folded)).toBe(line)
  })

  it('never splits a 4-octet emoji across the fold', () => {
    const line = `SUMMARY:${'🎉'.repeat(30)}`
    const folded = foldLine(line)
    for (const part of folded.split('\r\n')) {
      expect(octets(part)).toBeLessThanOrEqual(75)
      // With the `u` flag the class matches code points, so a well-formed pair
      // never matches and a half-split emoji always does.
      expect(part).not.toMatch(/[\uD800-\uDFFF]/u)
    }
    expect(unfold(folded)).toBe(line)
    expect(unfold(folded).split('🎉')).toHaveLength(31)
  })
})

describe('escapeText — RFC 5545 §3.3.11', () => {
  it('escapes backslash, semicolon, comma and newline', () => {
    expect(escapeText('a\\b')).toBe('a\\\\b')
    expect(escapeText('a;b')).toBe('a\\;b')
    expect(escapeText('a,b')).toBe('a\\,b')
    expect(escapeText('a\nb')).toBe('a\\nb')
    expect(escapeText('a\r\nb')).toBe('a\\nb')
  })

  it('escapes the backslash first so escapes are not double-escaped', () => {
    // Naive ordering turns this into `a\\;b` -> `a\\\\;b` or `a\;b`.
    expect(escapeText('a\\;b')).toBe('a\\\\\\;b')
  })

  it('does NOT escape colons', () => {
    expect(escapeText('Meeting: 09:41')).toBe('Meeting: 09:41')
  })

  it('quotes parameter values containing a comma or colon, and drops quotes', () => {
    expect(escapeParam('Ada Lovelace')).toBe('Ada Lovelace')
    expect(escapeParam('Lovelace, Ada')).toBe('"Lovelace, Ada"')
    expect(escapeParam('Ada "Countess" Lovelace')).toBe('Ada Countess Lovelace')
  })
})

describe('icsDateTimeUtc', () => {
  it('renders the UTC form', () => {
    expect(icsDateTimeUtc(Date.UTC(2026, 7, 14, 9, 5, 3))).toBe('20260814T090503Z')
  })

  it('zero-pads every field', () => {
    expect(icsDateTimeUtc(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('20260102T030405Z')
  })
})

describe('buildIcs — structure', () => {
  it('is CRLF-terminated throughout, with no bare LF', () => {
    const doc = ics()
    expect(doc.endsWith('\r\n')).toBe(true)
    expect(/[^\r]\n/.test(doc)).toBe(false)
    expect(doc.includes('\r\r')).toBe(false)
  })

  it('balances BEGIN and END', () => {
    const lines = contentLines(ics())
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR')
    expect(lines.filter((l) => l.startsWith('BEGIN:'))).toHaveLength(2)
    expect(lines.filter((l) => l.startsWith('END:'))).toHaveLength(2)
  })

  it('identifies Punctual in PRODID', () => {
    expect(ics()).toContain('PRODID:-//Punctual//Punctual Scheduling Engine//EN')
  })

  it('emits UTC DTSTAMP/DTSTART/DTEND', () => {
    const doc = ics()
    expect(doc).toContain('DTSTART:20260814T090000Z')
    expect(doc).toContain('DTEND:20260814T093000Z')
    expect(doc).toContain('DTSTAMP:20260810T120000Z')
  })

  it('formats ORGANIZER and ATTENDEE with CN and mailto', () => {
    const doc = unfold(ics())
    expect(doc).toContain('ORGANIZER;CN=Grace Hopper:mailto:grace@example.com')
    expect(doc).toContain('ATTENDEE;CN=Ada Lovelace;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ada@example.com')
  })

  it('keeps every content line within 75 octets and every continuation prefixed with a space', () => {
    const doc = ics(
      {
        eventType: eventType({
          title: 'Квартальний огляд 🎉 з командою продукту та інженерії — довга назва',
          description: 'Порядок денний; пункт перший, пункт другий\nі другий рядок',
        }),
      },
      { url: 'https://punctual.example/manage/abc,def?token=0123456789abcdef0123456789abcdef' },
    )
    const lines = contentLines(doc)
    // Something must actually have folded, or this test proves nothing.
    expect(lines.some((l) => l.startsWith(' '))).toBe(true)
    lines.forEach((line, i) => {
      expect(octets(line)).toBeLessThanOrEqual(75)
      // A continuation can never be the first line, and is the only shape a
      // leading space is allowed to take.
      if (line.startsWith(' ')) expect(i).toBeGreaterThan(0)
    })
    // Round-trip: unfolding restores the escaped values intact.
    expect(unfold(doc)).toContain('SUMMARY:Квартальний огляд 🎉 з командою продукту та інженерії — довга назва')
  })

  it('escapes TEXT values but leaves the URL alone', () => {
    const url = 'https://punctual.example/m/abc,def;x=1'
    const doc = unfold(
      ics({ eventType: eventType({ title: 'Design; review, round 2 \\ final' }) }, { url }),
    )
    expect(doc).toContain('SUMMARY:Design\\; review\\, round 2 \\\\ final')
    expect(doc).toContain(`URL:${url}`)
    expect(doc).not.toContain('URL:https://punctual.example/m/abc\\,def')
  })

  it('folds a description built from answers without losing the escaped newlines', () => {
    const et = eventType({
      questions: [
        { id: 'q1', label: 'What would you like to cover?', type: 'textarea', required: true },
      ],
    })
    const doc = unfold(ics({ eventType: et, booking: booking({ answers: { q1: 'Pricing, and the API' } }) }))
    const description = propertyValue(doc, 'DESCRIPTION')!
    expect(description).toContain('What would you like to cover?: Pricing\\, and the API')
    expect(description).toContain('\\n')
    expect(description).not.toMatch(/[\r\n]/)
  })
})

describe('buildIcs — method and status', () => {
  it('REQUEST is CONFIRMED and OPAQUE', () => {
    const doc = ics()
    expect(doc).toContain('METHOD:REQUEST')
    expect(doc).toContain('STATUS:CONFIRMED')
    expect(doc).toContain('TRANSP:OPAQUE')
  })

  it('CANCEL is CANCELLED and frees the time', () => {
    const cancelled = booking({ status: 'cancelled', cancelledAt: Date.UTC(2026, 7, 12, 8, 0, 0) })
    const doc = ics({ booking: cancelled }, { method: 'CANCEL', sequence: 1 })
    expect(doc).toContain('METHOD:CANCEL')
    expect(doc).toContain('STATUS:CANCELLED')
    expect(doc).toContain('TRANSP:TRANSPARENT')
    // DTSTAMP is the cancellation, not the creation — clients order by it.
    expect(doc).toContain('DTSTAMP:20260812T080000Z')
  })
})

describe('UID and SEQUENCE — update vs duplicate', () => {
  const original: RescheduleLink = { id: 'bk_1', rescheduleOf: null }
  const second: RescheduleLink = { id: 'bk_2', rescheduleOf: 'bk_1' }
  const third: RescheduleLink = { id: 'bk_3', rescheduleOf: 'bk_2' }
  const chain = new Map<string, RescheduleLink>([
    ['bk_1', original],
    ['bk_2', second],
    ['bk_3', third],
  ])

  it('a reschedule keeps the ORIGINAL UID', () => {
    expect(icsUidForBooking(original, NO_CHAIN)).toBe('bk_1@punctual')
    expect(icsUidForBooking(second, chain)).toBe('bk_1@punctual')
    expect(icsUidForBooking(third, chain)).toBe('bk_1@punctual')
  })

  it('SEQUENCE increases with chain depth', () => {
    expect(icsSequenceForBooking(original, NO_CHAIN)).toBe(0)
    expect(icsSequenceForBooking(second, chain)).toBe(1)
    expect(icsSequenceForBooking(third, chain)).toBe(2)
  })

  it('a cancellation outranks the REQUEST it revokes', () => {
    expect(icsSequenceForBooking(second, chain, true)).toBe(2)
    expect(icsSequenceForBooking(second, chain, true)).toBeGreaterThan(
      icsSequenceForBooking(second, chain),
    )
  })

  it('survives a cycle rather than hanging', () => {
    const a: RescheduleLink = { id: 'a', rescheduleOf: 'b' }
    const b: RescheduleLink = { id: 'b', rescheduleOf: 'a' }
    const cyclic = new Map([
      ['a', a],
      ['b', b],
    ])
    expect(icsRootBookingId(a, cyclic)).toBeTypeOf('string')
    expect(icsSequenceForBooking(a, cyclic)).toBeGreaterThan(0)
  })

  it('the rescheduled .ics is an UPDATE: same UID, higher SEQUENCE, new DTSTART', () => {
    const first = ics({ booking: booking() }, { uid: icsUidForBooking(original, NO_CHAIN), sequence: 0 })
    const moved = booking({
      id: 'bk_2',
      rescheduleOf: 'bk_1',
      startUtc: START + 86_400_000,
      endUtc: START + 86_400_000 + 30 * 60_000,
    })
    const update = ics(
      { booking: moved },
      { uid: icsUidForBooking(moved, chain), sequence: icsSequenceForBooking(moved, chain) },
    )
    expect(propertyValue(update, 'UID')).toBe(propertyValue(first, 'UID'))
    expect(Number(propertyValue(update, 'SEQUENCE'))).toBeGreaterThan(
      Number(propertyValue(first, 'SEQUENCE')),
    )
    expect(propertyValue(update, 'DTSTART')).not.toBe(propertyValue(first, 'DTSTART'))
    expect(propertyValue(update, 'METHOD')).toBe('REQUEST')
  })

  // ---------------------------------------------------------------------
  // Regression: a two-hop chain (A → B → C) needs the FULL lineage, or both
  // the UID and the SEQUENCE come out wrong on the second reschedule.
  // ---------------------------------------------------------------------

  it('a two-hop chain resolves to the correct root UID at every hop, given the full chain', () => {
    // A → B → C: whichever hop asks, the UID must point at A.
    expect(icsUidForBooking(original, chain)).toBe('bk_1@punctual')
    expect(icsUidForBooking(second, chain)).toBe('bk_1@punctual')
    expect(icsUidForBooking(third, chain)).toBe('bk_1@punctual')
  })

  it('a two-hop chain gets a strictly increasing SEQUENCE at every hop, given the full chain', () => {
    const seqA = icsSequenceForBooking(original, chain)
    const seqB = icsSequenceForBooking(second, chain)
    const seqC = icsSequenceForBooking(third, chain)
    expect(seqA).toBe(0)
    expect(seqB).toBeGreaterThan(seqA)
    expect(seqC).toBeGreaterThan(seqB)
  })

  it('an empty/missing chain silently produces the WRONG UID for the second hop of a two-hop reschedule', () => {
    // This is exactly what making `chain` a required parameter guards
    // against: a caller that forgets to load the lineage now has to pass
    // SOMETHING, and this test documents why that something must be the
    // full chain rather than an empty map. C's immediate predecessor is B,
    // not A — so with no chain to look B up in, resolution stops one hop
    // short and lands on B's id instead of the true root, which makes a
    // calendar client create a SECOND event instead of moving the first.
    const wrongUid = icsUidForBooking(third, NO_CHAIN)
    const correctUid = icsUidForBooking(third, chain)
    expect(wrongUid).toBe('bk_2@punctual')
    expect(correctUid).toBe('bk_1@punctual')
    expect(wrongUid).not.toBe(correctUid)
  })

  it('an empty/missing chain also under-counts SEQUENCE for the second hop', () => {
    // With no lineage to walk, C's depth reads as 1 — the same SEQUENCE
    // already used for B's own REQUEST — instead of 2.
    expect(icsSequenceForBooking(third, NO_CHAIN)).toBe(1)
    expect(icsSequenceForBooking(second, chain)).toBe(1)
    expect(icsSequenceForBooking(third, chain)).toBe(2)
  })

  // ---------------------------------------------------------------------
  // Regression: a CANCEL for the leg a reschedule superseded must never be
  // sent — its SEQUENCE cannot be made to reliably outrank the REQUEST of
  // the booking that replaced it, because the two are computed from
  // independent chain walks that cannot see each other.
  // ---------------------------------------------------------------------

  it('a superseded leg (CANCEL) and its replacement (REQUEST) can collide on the same SEQUENCE for the same UID', () => {
    // A is rescheduled to B: same UID, and if A were (incorrectly) also sent
    // as a CANCEL, both computations start from A's own one-hop chain depth.
    const cancelSequenceForA = icsSequenceForBooking(original, NO_CHAIN, true)
    const requestSequenceForB = icsSequenceForBooking(second, chain)
    expect(icsUidForBooking(original, NO_CHAIN)).toBe(icsUidForBooking(second, chain))
    expect(cancelSequenceForA).toBe(requestSequenceForB)
  })

  it('icsCancelSuppressed is true for a booking superseded by a reschedule, false for a real cancellation', () => {
    expect(icsCancelSuppressed({ rescheduledTo: 'bk_2' })).toBe(true)
    expect(icsCancelSuppressed({ rescheduledTo: null })).toBe(false)
  })
})
