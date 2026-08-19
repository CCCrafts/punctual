import { describe, expect, it } from 'vitest'
import type { EventType, Slot, User } from '../../src/core/domain/types.js'
import { eventHeader, slotList, type BookingPageData } from '../../src/http/pages/booking.js'

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

  /**
   * Regression: the option list is built once per isolate and patched per
   * request (see TIMEZONE_OPTIONS_BASE) rather than re-escaped every time —
   * a real request-rate CI failure traced back to the unoptimized version
   * being slow enough to let the rate limiter's token bucket refill mid-test.
   * The patching must still mark exactly one option `selected`, and must not
   * corrupt a look-alike zone name in the process.
   */
  it('marks exactly one option selected, and it is the guest zone', () => {
    const html = eventHeader(pageData({ guestTimezone: 'America/New_York' }))
    const selectedCount = (html.match(/ selected>/g) ?? []).length
    expect(selectedCount).toBe(1)
    expect(html).toContain('value="America/New_York" selected>')
  })

  it('prepends an unrecognized guest zone rather than dropping it', () => {
    // A real zone, but a legacy alias `supportedValuesOf('timeZone')` omits
    // from its canonical list — still valid input to Intl itself, so this
    // exercises the "not in TIMEZONES" branch without an invalid-timezone
    // exception from the unrelated offset-label formatting.
    const html = eventHeader(pageData({ guestTimezone: 'US/Eastern' }))
    expect(html).toContain('value="US/Eastern" selected>')
  })
})

/**
 * CCC-493: the slot picker must go through the shared slot-state → class
 * mapping (src/core/slot-state.ts), not a hardcoded "pu-slot" literal — this
 * is the one place the semantic token layer's slot states are actually
 * proven live, since the query engine (src/core/slots/engine.ts) only ever
 * hands this page 'available' slots.
 */
describe('slotList slot-state wiring', () => {
  const slots: Slot[] = [{ start: 1_789_000_000_000, end: 1_789_001_800_000, eligibleHostIds: ['u_host'] }]

  it('renders each slot with the shared available slot-state class, not a bare "pu-slot"', () => {
    const html = slotList(pageData({ selectedDate: '2026-09-10', slots }))
    expect(html).toContain('class="pu-slot pu-slot-available"')
    expect(html).not.toContain('class="pu-slot"')
  })

  it('still renders as a real, focusable link — available slots stay interactive', () => {
    const html = slotList(pageData({ selectedDate: '2026-09-10', slots }))
    expect(html).toMatch(/<a class="pu-slot pu-slot-available" href="[^"]+">/)
  })
})
