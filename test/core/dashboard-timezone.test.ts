/**
 * Where a host's timezone comes from, and what the dashboard says when it
 * never arrived. The sign-in form carries the browser's zone in a hidden
 * field (the one script on that page); the availability page flags a default
 * schedule still on UTC, because "09:00–17:00" reads as correct until you
 * know which zone it is in.
 */

import { describe, expect, it } from 'vitest'
import type { Schedule, Team, User } from '../../src/core/domain/types.js'
import { loginPage, schedulesPage } from '../../src/http/pages/dashboard.js'

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
    weekly: [[], [], [], [], [], [], []],
    overrides: [],
    ...overrides,
  }
}

const chrome = { brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'brevo' as const }

describe('login form timezone field', () => {
  it('submits the browser zone in a hidden field that is empty without script', () => {
    const html = loginPage({ brandName: 'Punctual', providers: [] })
    expect(html).toContain('<input type="hidden" name="tz" id="login-tz" value="">')
    expect(html).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone")
    // The script only fills the field; the form must not depend on it.
    expect(html).not.toContain('onsubmit')
  })

  it('is absent from the "check your inbox" state, which has no form', () => {
    expect(loginPage({ brandName: 'Punctual', providers: [], sent: true })).not.toContain('name="tz"')
  })
})

describe('availability page UTC callout', () => {
  it('flags a default schedule still on UTC and links to its editor', () => {
    const html = schedulesPage({ ...chrome, schedules: [schedule()] })
    expect(html).toContain('Your hours are read in UTC')
    expect(html).toContain('pu-callout-warn')
    expect(html).toContain('href="/dashboard/availability/sch_default">Working hours</a>')
    // A warning, not an error: the danger tint is reserved for "this breaks links".
    expect(html).not.toContain('role="alert"')
  })

  it('says nothing once the default has a real zone, even if another schedule is UTC', () => {
    const html = schedulesPage({
      ...chrome,
      schedules: [schedule({ timezone: 'Europe/Kyiv' }), schedule({ id: 'sch_utc', name: 'Calls', isDefault: false })],
    })
    expect(html).not.toContain('Your hours are read in UTC')
  })

  it('does not second-guess a member\'s zone on a team admin\'s view of their hours', () => {
    const team = { id: 'team_1', name: 'Sales', slug: 'sales' } as Team
    const html = schedulesPage({
      ...chrome,
      schedules: [schedule()],
      scope: { subject: { ...user, id: 'u_member', slug: 'member' }, basePath: '/dashboard/teams/team_1/members/u_member/availability', team },
    })
    expect(html).not.toContain('Your hours are read in UTC')
  })
})
