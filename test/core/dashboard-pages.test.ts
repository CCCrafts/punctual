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

describe('calendars page', () => {
  it('titles the connect card by how many calendars are already connected', () => {
    expect(connectionsPage({ ...chrome, connections: [], availableProviders: ['google'] })).toContain(
      '<h2>Connect a calendar</h2>',
    )
    expect(
      connectionsPage({
        ...chrome,
        connections: [{ connection: connection(), calendars: listed }],
        availableProviders: ['google'],
      }),
    ).toContain('<h2>Connect another calendar</h2>')
  })

  it('tells a host without a provider who can fix it, and where', () => {
    const html = connectionsPage({ ...chrome, connections: [], availableProviders: [] })
    expect(html).toContain('This deployment has no Google or Microsoft credentials yet')
    expect(html).toContain('href="/docs/self-hosting"')
    expect(html).toContain('otherwise ask your admin')
    expect(html).not.toContain("Set the provider's")
  })

  it('offers only Reconnect and Disconnect on a connection that needs reconnecting', () => {
    const html = connectionsPage({
      ...chrome,
      connections: [{ connection: connection({ syncStatus: 'needs_reconnect' }), calendars: [] }],
      availableProviders: ['google'],
    })
    expect(html).toContain('href="/auth/google/start?purpose=calendar"')
    expect(html).toContain('action="/dashboard/connections/cal_1/disconnect"')
    expect(html).toContain('Needs reconnect')
    // The form would promise a Save that cannot work until the tokens are back.
    expect(html).not.toContain('Check these for conflicts')
    expect(html).not.toContain('>Save<')
    expect(html).not.toContain('action="/dashboard/connections/cal_1"')
  })

  it('keeps the form on a healthy connection, with Disconnect as a ghost on the Save row', () => {
    const html = connectionsPage({
      ...chrome,
      connections: [{ connection: connection(), calendars: listed }],
      availableProviders: ['google'],
    })
    expect(html).toContain('Check these for conflicts')
    expect(html).toContain('(primary)')
    expect(html).toContain('pu-btn pu-btn-ghost pu-btn-ghost-danger" type="submit" form="disconnect-cal_1"')
    expect(html).toContain('<form id="disconnect-cal_1" method="post" action="/dashboard/connections/cal_1/disconnect"')
    expect(html).not.toContain('pu-btn pu-btn-danger')
  })

  it('names a stored calendar id honestly when the provider would not list calendars', () => {
    const html = connectionsPage({
      ...chrome,
      connections: [{ connection: connection({ syncStatus: 'error', calendarIdsRead: ['work@x'] }), calendars: [] }],
      availableProviders: ['google'],
    })
    expect(html).toContain('work@x <span class="pu-muted">&mdash; could not list calendars</span>')
    expect(html).toContain('Sync error')
  })

  it('draws sync state with a dot as well as a colour, from the status tokens', () => {
    const ok = connectionsPage({ ...chrome, connections: [{ connection: connection(), calendars: listed }], availableProviders: [] })
    expect(ok).toContain('<span class="pu-badge pu-badge-dot">Connected</span>')
    const broken = connectionsPage({
      ...chrome,
      connections: [{ connection: connection({ syncStatus: 'needs_reconnect' }), calendars: [] }],
      availableProviders: [],
    })
    expect(broken).toContain('<span class="pu-badge pu-badge-dot pu-badge-danger">Needs reconnect</span>')
    expect(broken).not.toContain('class="pu-badge" style=')
  })
})
