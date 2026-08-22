import { describe, expect, it } from 'vitest'
import { groupByDay, parseSlotsArgs, pickEventType } from '../src/slots.js'

describe('pickEventType', () => {
  const personal = { id: 'et_1', slug: '30min', title: 'Quick chat', durationMinutes: 30 }
  const team = { id: 'et_2', slug: '30min', title: 'Sales intro', durationMinutes: 30 }
  const other = { id: 'et_3', slug: 'deep-dive', title: 'Deep dive', durationMinutes: 60 }

  it('an empty instance is its own case, never "several — pick one"', () => {
    expect(pickEventType([], undefined)).toEqual({ kind: 'empty' })
    expect(pickEventType([], '30min')).toEqual({ kind: 'empty' })
  })

  it('a slug shared by a personal and a team event type is ambiguous, never first-match-wins', () => {
    expect(pickEventType([personal, team], '30min')).toEqual({ kind: 'ambiguous', matches: [personal, team] })
  })

  it('an id always resolves uniquely, which is the escape hatch for ambiguous slugs', () => {
    expect(pickEventType([personal, team], 'et_2')).toEqual({ kind: 'ok', match: team })
  })

  it('a unique slug resolves; a single event type needs no --event at all', () => {
    expect(pickEventType([personal, other], 'deep-dive')).toEqual({ kind: 'ok', match: other })
    expect(pickEventType([other], undefined)).toEqual({ kind: 'ok', match: other })
  })

  it('several event types with no --event lists them; a wrong slug is not-found', () => {
    expect(pickEventType([personal, other], undefined)).toEqual({ kind: 'unspecified', all: [personal, other] })
    expect(pickEventType([personal, other], 'nope')).toEqual({ kind: 'not-found' })
  })
})

describe('parseSlotsArgs', () => {
  it('takes a bare URL as the positional argument', () => {
    expect(parseSlotsArgs(['https://book.example.com'])).toMatchObject({
      url: 'https://book.example.com',
      days: 7,
    })
  })

  it('parses the full flag set', () => {
    expect(parseSlotsArgs(['--url', 'https://x', '--key', 'pk_1', '--event', '30min', '--days', '3', '--tz', 'Europe/Kyiv'])).toEqual({
      url: 'https://x',
      key: 'pk_1',
      event: '30min',
      days: 3,
      tz: 'Europe/Kyiv',
    })
  })

  it('rejects out-of-range days and unknown flags', () => {
    expect(parseSlotsArgs(['--days', '0']).error).toBeTruthy()
    expect(parseSlotsArgs(['--days', 'x']).error).toBeTruthy()
    expect(parseSlotsArgs(['--frobnicate']).error).toContain('--frobnicate')
  })

  it('rejects a flag with a missing value instead of eating the next flag', () => {
    expect(parseSlotsArgs(['--url']).error).toBeTruthy()
  })
})

describe('groupByDay', () => {
  it('groups by localDate, sorted, with tabular time cells', () => {
    const zone = 'Europe/Kyiv'
    const slot = (iso: string, localDate: string) => ({ start: { epochMs: Date.parse(iso) }, localDate })
    const grouped = groupByDay(
      [
        slot('2026-08-26T06:00:00Z', '2026-08-26'),
        slot('2026-08-25T06:00:00Z', '2026-08-25'),
        slot('2026-08-25T06:30:00Z', '2026-08-25'),
      ],
      zone,
    )
    expect(grouped).toEqual([
      { day: 'Tue 25 Aug', times: ['09:00', '09:30'] },
      { day: 'Wed 26 Aug', times: ['09:00'] },
    ])
  })
})
