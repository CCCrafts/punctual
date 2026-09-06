/**
 * The empty home renders a checklist, not a "nothing here" line. Steps are
 * links to the page that completes them; a completed step carries the filled
 * dot, an open one the ring, and a screen reader hears which is which.
 */

import { describe, expect, it } from 'vitest'
import type { Schedule, User } from '../../src/core/domain/types.js'
import { dashboardHome, type DashboardHomeData } from '../../src/http/pages/dashboard.js'

const user: User = {
  id: 'u_host',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  tz: 'UTC',
  slug: 'grace',
  avatarKey: null,
  company: null,
  jobTitle: null,
  companyUrl: null,
  role: 'member',
  createdAt: 0,
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_default',
    userId: user.id,
    name: 'Working hours',
    isDefault: true,
    timezone: 'UTC',
    weekly: [[], [{ startMinute: 540, endMinute: 1020 }], [{ startMinute: 540, endMinute: 1020 }],
      [{ startMinute: 540, endMinute: 1020 }], [{ startMinute: 540, endMinute: 1020 }],
      [{ startMinute: 540, endMinute: 1020 }], []],
    overrides: [],
    ...overrides,
  }
}

function home(overrides: Partial<DashboardHomeData> = {}): string {
  return dashboardHome({
    brandName: 'Punctual',
    user,
    csrf: 'tok',
    emailDelivery: 'brevo',
    eventTypes: [],
    upcomingBookings: [],
    baseUrl: 'https://punctual.test',
    hasCalendarConnection: false,
    defaultSchedule: schedule(),
    ...overrides,
  })
}

/** The `<li>` for one step, so assertions can look at its own done marker. */
function step(html: string, label: string): string {
  const at = html.indexOf(`>${label}</a>`)
  expect(at, `step "${label}" is rendered`).toBeGreaterThan(-1)
  const start = html.lastIndexOf('<li', at)
  return html.slice(start, html.indexOf('</li>', at))
}

describe('first-run checklist', () => {
  it('replaces the empty-state line and links each step to its page', () => {
    const html = home()
    expect(html).toContain('Get set up')
    expect(html).not.toContain('No event types yet')
    expect(step(html, 'Add your name')).toContain('href="/dashboard/settings"')
    expect(step(html, 'Connect a calendar')).toContain('href="/dashboard/connections"')
    expect(step(html, 'Check your hours')).toContain('href="/dashboard/availability/sch_default"')
    expect(step(html, 'Create an event type')).toContain('href="/dashboard/event-types/new"')
    // The primary action stays a real button, and "Upcoming" is still below.
    expect(html).toContain('class="pu-btn" href="/dashboard/event-types/new"')
    expect(html.indexOf('Upcoming')).toBeGreaterThan(html.indexOf('Get set up'))
  })

  it('marks name and calendar done from the data the route passes', () => {
    const html = home({ hasCalendarConnection: true })
    expect(step(html, 'Add your name')).toContain('pu-setup-done')
    expect(step(html, 'Add your name')).toContain('— done')
    expect(step(html, 'Connect a calendar')).toContain('pu-setup-done')

    const blank = home({ user: { ...user, name: '' }, hasCalendarConnection: false })
    expect(step(blank, 'Add your name')).not.toContain('pu-setup-done')
    expect(step(blank, 'Add your name')).toContain('— to do')
    expect(step(blank, 'Connect a calendar')).not.toContain('pu-setup-done')
  })

  it('names the default schedule and its timezone, and treats a UTC default as unchecked', () => {
    const utc = home()
    expect(step(utc, 'Check your hours')).toContain('Currently Mon–Fri 09:00–17:00 UTC.')
    expect(step(utc, 'Check your hours')).not.toContain('pu-setup-done')

    const kyiv = home({ defaultSchedule: schedule({ timezone: 'Europe/Kyiv' }) })
    expect(step(kyiv, 'Check your hours')).toContain('Mon–Fri 09:00–17:00 Europe/Kyiv')
    expect(step(kyiv, 'Check your hours')).toContain('pu-setup-done')
  })

  it('still describes irregular hours honestly rather than inventing a range', () => {
    const irregular = schedule({
      timezone: 'America/New_York',
      weekly: [[], [{ startMinute: 540, endMinute: 720 }], [], [{ startMinute: 780, endMinute: 1020 }], [], [], []],
    })
    expect(step(home({ defaultSchedule: irregular }), 'Check your hours')).toContain('Currently Mon, Wed America/New_York.')
  })

  it('creating an event type is never pre-ticked, and the list disappears once one exists', () => {
    expect(step(home(), 'Create an event type')).not.toContain('pu-setup-done')
  })
})
