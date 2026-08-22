import { describe, expect, it } from 'vitest'
import { groupByDay, parseSlotsArgs } from '../src/slots.js'

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
