import { describe, expect, it } from 'vitest'
import type { EventType, User } from '../../src/core/domain/types.js'
import { eventHeader, type BookingPageData } from '../../src/http/pages/booking.js'

const host: User = {
  id: 'u_host',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  tz: 'America/New_York',
  slug: 'grace',
  createdAt: 0,
}

const eventType: EventType = {
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
}

function pageData(patch: Partial<BookingPageData> = {}): BookingPageData {
  return {
    host,
    ownerSlug: 'grace',
    eventType,
    month: '2026-09',
    daysWithSlots: new Map(),
    guestTimezone: 'America/New_York',
    baseUrl: 'https://example.test',
    ...patch,
  }
}

/**
 * Regression: the timezone picker form used to always post back to the
 * month/day view, which silently dropped whatever page-specific state
 * (selected day, chosen slot) the guest had already committed to.
 */
describe('eventHeader timezone picker', () => {
  it('preserves the selected day when switching zones on the day view', () => {
    const html = eventHeader(pageData({ selectedDate: '2026-09-10' }))
    expect(html).toContain('action="/grace/intro"')
    expect(html).toContain('name="date" value="2026-09-10"')
  })

  it('posts to /confirm with the chosen slot on the confirm page', () => {
    const html = eventHeader(pageData({ confirmStart: 1789000000000 }))
    expect(html).toContain('action="/grace/intro/confirm"')
    expect(html).toContain('name="start" value="1789000000000"')
    // The confirm context has no date/month to preserve — carrying them
    // over would just be dead query params on a route that ignores them.
    expect(html).not.toContain('name="date"')
    expect(html).not.toContain('name="month"')
  })

  it('offers UTC even when the guest is not already on it', () => {
    const html = eventHeader(pageData({ guestTimezone: 'America/New_York' }))
    expect(html).toContain('<option value="UTC"')
  })
})
