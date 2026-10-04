/**
 * The admin page's shape: title above the cards, a users table that scrolls
 * on a phone instead of folding every cell, and a Closed option that says
 * how to let one more person in later.
 */

import { describe, expect, it } from 'vitest'
import type { User } from '../../src/core/domain/types.js'
import { adminPage } from '../../src/http/pages/dashboard.js'

function person(overrides: Partial<User> & Pick<User, 'id' | 'email' | 'slug'>): User {
  return {
    name: 'Someone',
    tz: 'UTC',
    avatarKey: null,
    company: null,
    jobTitle: null,
    companyUrl: null,
    role: 'member',
    createdAt: 0,
    ...overrides,
  }
}

const admin = person({ id: 'u_admin', email: 'alice@example.test', slug: 'alice', name: 'Alice', role: 'admin' })
const bob = person({ id: 'u_bob', email: 'bob@example.test', slug: 'bob-the-builder', name: 'Bob' })

function page(signups = 'open'): string {
  return adminPage({
    brandName: 'Punctual',
    user: admin,
    csrf: 'tok',
    emailDelivery: 'brevo',
    allUsers: [admin, bob],
    signups: { value: signups, pinnedByEnv: false },
    companyLogo: null,
    home: { mode: 'landing', title: '', intro: '', eventTypeIds: [], featuredId: null, website: '', contactEmail: '' },
    traffic: null,
    trafficConfigured: false,
    homeChoices: [],
  })
}

describe('adminPage', () => {
  it('lifts the title and lede above the cards', () => {
    const html = page()
    const h1 = html.indexOf('<h1>Admin</h1>')
    expect(h1).toBeGreaterThan(-1)
    expect(h1).toBeLessThan(html.indexOf('<section class="pu-card"'))
  })

  it('gives the users table a width floor and keeps slugs and actions on one line', () => {
    const html = page()
    expect(html).toContain('<table class="pu-dash-table" style="width:100%;min-width:30rem">')
    expect(html).toContain('<td class="pu-time" style="white-space:nowrap">/bob-the-builder</td>')
    const button = html.slice(html.indexOf('Make admin') - 200, html.indexOf('Make admin'))
    expect(button).toContain('white-space:nowrap')
  })

  it('labels the action column for screen readers without showing a heading', () => {
    expect(page()).toContain('<th scope="col" style="text-align:left"><span class="pu-sr">Actions</span></th>')
  })

  it('tells an admin closing sign-ups how to admit one more person later', () => {
    expect(page('closed')).toContain('To add someone later, switch to Allowlist and enter their email.')
  })
})

describe('the traffic section', () => {
  it('explains what to configure, says when Cloudflare did not answer, and renders the numbers when it did', async () => {
    const { adminPage } = await import('../../src/http/pages/dashboard.js')
    const base = { brandName: 'Punctual', user: { id: 'u', email: 'a@x', name: 'A', tz: 'UTC', slug: 'a', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'admin' as const, createdAt: 0 }, csrf: 'tok', emailDelivery: 'brevo' as const, allUsers: [], signups: { value: 'open', pinnedByEnv: false }, companyLogo: null, home: { mode: 'landing' as const, title: '', intro: '', eventTypeIds: [], featuredId: null, website: '', contactEmail: '' }, homeChoices: [] }
    expect(adminPage({ ...base, traffic: null, trafficConfigured: false })).toContain('CLOUDFLARE_ZONE_ID')
    expect(adminPage({ ...base, traffic: null, trafficConfigured: true })).toContain('Cloudflare did not answer just now')
    const html = adminPage({ ...base, trafficConfigured: true, traffic: { since: '2026-09-20', until: '2026-10-04', total: 24514, days: [{ day: '2026-09-20', requests: 300 }], paths: [{ path: '/serge/30min/confirm', requests: 10837 }], countries: [{ country: 'US', requests: 3746 }], agents: [{ agent: '<script>x</script>', requests: 1 }] } })
    expect(html).toContain('24,514')
    expect(html).toContain('/serge/30min/confirm')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('<svg viewBox="0 0 720 80"')
  })
})
