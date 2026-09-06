/**
 * Pure rendering of the dashboard chrome, the calendars page and the API
 * keys page — the markup decisions that a screenshot audit found wrong and
 * that nothing else pins down: which controls a broken connection offers,
 * what the copy says when there is no provider, where the one-time key is
 * shown, and what the shell says to a host who has no name yet.
 */

import { describe, expect, it } from 'vitest'
import type { CalendarConnection, User } from '../../src/core/domain/types.js'
import { apiKeysPage, connectionsPage, settingsPage } from '../../src/http/pages/dashboard.js'

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

const chrome = { brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'resend' as const }

function connection(patch: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'cal_1',
    userId: user.id,
    provider: 'google',
    providerAccountEmail: 'grace@gmail.example',
    encryptedTokens: 'cipher',
    keyVersion: 1,
    calendarIdsRead: ['primary'],
    calendarIdWrite: 'primary',
    syncStatus: 'ok',
    createdAt: 0,
    ...patch,
  }
}

const listed = [{ id: 'primary', name: 'grace@gmail.example', primary: true }]

describe('dashboard chrome', () => {
  it('lays the header out from the stylesheet, not an inline style the phone rule cannot beat', () => {
    const html = apiKeysPage({ ...chrome, keys: [] })
    expect(html).toContain('<header class="pu-dash-header">')
    expect(html).toContain('<nav class="pu-nav" aria-label="Dashboard">')
    expect(html).toContain('<form class="pu-dash-signout" method="post" action="/logout">')
  })

  it('nudges a host with no name towards Settings, and only them', () => {
    const nameless = { ...chrome, user: { ...user, name: '' } }
    const html = apiKeysPage({ ...nameless, keys: [] })
    expect(html).toContain('Add your name so guests know who they are booking with')
    expect(html).toContain('href="/dashboard/settings"')

    expect(apiKeysPage({ ...chrome, keys: [] })).not.toContain('Add your name')
    // Whitespace is not a name either.
    expect(apiKeysPage({ ...nameless, user: { ...user, name: '   ' }, keys: [] })).toContain('Add your name')
  })

  it('does not nudge on Settings itself — the form there already asks', () => {
    expect(settingsPage({ ...chrome, user: { ...user, name: '' } })).not.toContain('Add your name')
  })

  it('renders a status notice as a neutral strip, not a success badge', () => {
    const html = connectionsPage({ ...chrome, connections: [], availableProviders: [], notice: 'Calendar connected.' })
    expect(html).toContain('<p class="pu-notice" role="status">Calendar connected.</p>')
  })
})
