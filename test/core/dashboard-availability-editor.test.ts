import { describe, expect, it } from 'vitest'
import type { Schedule, User, WeeklySchedule } from '../../src/core/domain/types.js'
import { MAX_RANGES_PER_DAY, parseWeeklyDraft, scheduleForm, type WeeklyDayDraft } from '../../src/http/pages/dashboard.js'

const user: User = {
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

function emptyWeek(): WeeklySchedule {
  return [[], [], [], [], [], [], []]
}

function draftDay(overrides: Partial<WeeklyDayDraft> = {}): WeeklyDayDraft {
  return { enabled: false, ranges: [], ...overrides }
}

function draftWeek(mondayOverrides: Partial<WeeklyDayDraft>): WeeklyDayDraft[] {
  const days = [0, 1, 2, 3, 4, 5, 6].map(() => draftDay())
  days[1] = draftDay(mondayOverrides) // index 1 = Monday
  return days
}

const schedule: Schedule = {
  id: 'sch_1',
  userId: 'u_host',
  name: 'Working hours',
  isDefault: true,
  timezone: 'America/New_York',
  weekly: emptyWeek(),
  overrides: [],
}

describe('parseWeeklyDraft', () => {
  it('saves a single range on an enabled day', () => {
    const { weekly, errors } = parseWeeklyDraft(
      draftWeek({ enabled: true, ranges: [{ start: '09:00', end: '17:00' }] }),
    )
    expect(errors).toEqual({})
    expect(weekly[1]).toEqual([{ startMinute: 540, endMinute: 1020 }])
  })

  it('saves multiple ranges on one day, e.g. a lunch-break split', () => {
    const { weekly, errors } = parseWeeklyDraft(
      draftWeek({
        enabled: true,
        ranges: [
          { start: '13:00', end: '17:00' },
          { start: '09:00', end: '12:00' },
        ],
      }),
    )
    expect(errors).toEqual({})
    // Sorted by start time regardless of input order.
    expect(weekly[1]).toEqual([
      { startMinute: 540, endMinute: 720 },
      { startMinute: 780, endMinute: 1020 },
    ])
  })

  it('round-trips 24:00 through the editor as 23:59', () => {
    const { weekly, errors } = parseWeeklyDraft(
      draftWeek({ enabled: true, ranges: [{ start: '09:00', end: '23:59' }] }),
    )
    expect(errors).toEqual({})
    expect(weekly[1]).toEqual([{ startMinute: 540, endMinute: 1440 }])
  })

  it('silently skips a range row where both times are blank', () => {
    const { weekly, errors } = parseWeeklyDraft(
      draftWeek({
        enabled: true,
        ranges: [
          { start: '09:00', end: '17:00' },
          { start: '', end: '' },
        ],
      }),
    )
    expect(errors).toEqual({})
    expect(weekly[1]).toEqual([{ startMinute: 540, endMinute: 1020 }])
  })

  it('rejects a range with only one time filled', () => {
    const { weekly, errors } = parseWeeklyDraft(draftWeek({ enabled: true, ranges: [{ start: '09:00', end: '' }] }))
    expect(errors['day-1']).toBe('Each range needs a start before its end')
    expect(weekly[1]).toEqual([])
  })

  it('rejects an inverted range (end before start)', () => {
    const { weekly, errors } = parseWeeklyDraft(
      draftWeek({ enabled: true, ranges: [{ start: '17:00', end: '09:00' }] }),
    )
    expect(errors['day-1']).toBe('Each range needs a start before its end')
    expect(weekly[1]).toEqual([])
  })

  it('ignores a disabled day\'s typed ranges entirely', () => {
    const { weekly, errors } = parseWeeklyDraft(
      draftWeek({ enabled: false, ranges: [{ start: '09:00', end: '17:00' }] }),
    )
    expect(errors).toEqual({})
    expect(weekly[1]).toEqual([])
  })
})

describe('scheduleForm weekly editor', () => {
  it('renders a switch and one empty range row for a day with no saved windows', () => {
    const html = scheduleForm({ brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'brevo', schedule })
    expect(html).toContain('name="day-1-enabled"')
    expect(html).toContain('name="day-1-start-0"')
    expect(html).not.toContain('day-1-enabled" class="pu-switch-input" checked')
  })

  it('preserves an in-progress weeklyDraft (e.g. after "+ Add range") instead of reverting to saved state', () => {
    const html = scheduleForm({
      brandName: 'Punctual',
      user,
      csrf: 'tok', emailDelivery: 'brevo',
      schedule,
      weeklyDraft: draftWeek({
        enabled: true,
        ranges: [
          { start: '09:00', end: '12:00' },
          { start: '', end: '' },
        ],
      }),
    })
    expect(html).toContain('name="day-1-start-0" value="09:00"')
    expect(html).toContain('name="day-1-start-1" value=""')
  })

  it('matches rest.ts\'s dayWindowSchema array cap, so a schedule saved with 12 windows via the API survives a dashboard save', () => {
    expect(MAX_RANGES_PER_DAY).toBe(12)
  })

  it('puts a hidden default-submit Save button before Sunday\'s "+ Add range", so pressing Enter anywhere saves rather than adding a row', () => {
    const html = scheduleForm({ brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'brevo', schedule })
    const hiddenSaveIndex = html.indexOf('class="pu-sr" tabindex="-1" formnovalidate')
    const firstAddRangeIndex = html.indexOf('name="add-range"')
    expect(hiddenSaveIndex).toBeGreaterThan(-1)
    expect(firstAddRangeIndex).toBeGreaterThan(-1)
    expect(hiddenSaveIndex).toBeLessThan(firstAddRangeIndex)
  })

  it('marks the real Save button formnovalidate, so a hidden disabled-day time input can never block submission', () => {
    const html = scheduleForm({ brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'brevo', schedule })
    expect(html).toContain('<button class="pu-btn" type="submit" formnovalidate>Save schedule</button>')
  })
})
