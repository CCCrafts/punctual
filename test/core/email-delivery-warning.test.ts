/**
 * The standing "email is not configured" warning.
 *
 * This exists because of a real incident: a live instance ran for a week with
 * no provider key, silently logging every confirmation instead of sending it,
 * and took nine real bookings before anyone noticed. Nothing about the product
 * looked wrong — bookings committed, calendars synced, the dashboard was
 * healthy. The only symptom was on the guests' side, where nothing arrived.
 *
 * So the warning itself is the feature, and a warning that silently stops
 * firing is the same class of bug it was added to catch. Hence: assert it
 * appears when delivery is degraded, and — just as importantly — that it does
 * NOT appear on a configured deployment, since a banner that cries wolf on a
 * healthy instance is one operators learn to scroll past.
 */

import { describe, expect, it } from 'vitest'
import type { User } from '../../src/core/domain/types.js'
import { dashboardHome, settingsPage } from '../../src/http/pages/dashboard.js'

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

const base = { brandName: 'Punctual', user, csrf: 'tok' }
const home = { ...base, eventTypes: [], upcomingBookings: [], baseUrl: 'https://punctual.test' }

describe('email-not-configured banner', () => {
  it('warns when the deployment resolved to the console sender', () => {
    const html = dashboardHome({ ...home, emailDelivery: 'console' })
    expect(html).toContain('Email is not configured')
    expect(html).toContain('role="alert"')
    // Names both keys — the operator should not have to go read the docs to
    // find out which secret is missing.
    expect(html).toContain('RESEND_API_KEY')
    expect(html).toContain('BREVO_API_KEY')
  })

  it('stays silent on a configured deployment', () => {
    for (const mode of ['resend', 'brevo'] as const) {
      const html = dashboardHome({ ...home, emailDelivery: mode })
      expect(html).not.toContain('Email is not configured')
    }
  })

  /**
   * The banner lives in `shellTop`, so it rides the shared chrome rather than
   * being pasted per page. Checking unrelated pages is what proves that — if
   * it were inlined into the home page only, these fail.
   *
   * `emailDelivery` is a REQUIRED field on `DashboardChrome` precisely so a
   * new page cannot quietly omit it: that is a compile error, not a page
   * that renders fine while mail goes nowhere. `/dashboard/settings` was
   * caught missing it while the field was still optional, which is why it is
   * named explicitly here.
   */
  it('rides the shared chrome, so every dashboard page shows it', () => {
    expect(settingsPage({ ...base, emailDelivery: 'console' })).toContain('Email is not configured')
    expect(dashboardHome({ ...home, emailDelivery: 'console' })).toContain('Email is not configured')
  })

  it('is not dismissible and not admin-gated', () => {
    // A host who cannot fix the config still needs to know their guests are
    // getting nothing, so `role: 'member'` must see it too.
    const html = dashboardHome({ ...home, user: { ...user, role: 'member' }, emailDelivery: 'console' })
    expect(html).toContain('Email is not configured')
    expect(html).not.toContain('dismiss')
  })
})
