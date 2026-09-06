import { describe, expect, it } from 'vitest'
import type { User } from '../../src/core/domain/types.js'
import { settingsPage } from '../../src/http/pages/dashboard.js'

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

/**
 * Regression: the slug-change caution was a multi-sentence paragraph with an
 * inline <code>, rendered with the `.pu-err` class — meant for a short
 * one-line field error and styled `display:flex`, which splits a long
 * paragraph's text nodes into separate flex items instead of letting it wrap
 * normally. Found via a live dashboard QA pass: the slug value visually
 * landed in its own column next to the warning text.
 */
describe('settingsPage slug-change caution', () => {
  it('does not reuse .pu-err (flex, built for one-line field errors) for the standing warning', () => {
    const html = settingsPage({ brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'brevo', baseUrl: 'https://punctual.test' })
    expect(html).toContain('pu-callout')
    // .pu-err is still fine elsewhere on the page (an actual field error).
    const calloutSection = html.slice(html.indexOf('pu-callout'), html.indexOf('</div>', html.indexOf('pu-callout')))
    expect(calloutSection).not.toContain('pu-err')
  })

  it('still names the current slug in the warning text', () => {
    const html = settingsPage({ brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'brevo', baseUrl: 'https://punctual.test' })
    expect(html).toContain('<code>/grace</code>')
  })
})

describe('settingsPage photo section', () => {
  it('shows an initials badge and no Remove button when nothing is uploaded', () => {
    const html = settingsPage({ brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'brevo', baseUrl: 'https://punctual.test' })
    expect(html).toContain('>G<') // initial of "Grace Hopper"
    expect(html).not.toContain('/dashboard/settings/avatar/delete')
    expect(html).toContain('action="/dashboard/settings/avatar"')
    expect(html).toContain('enctype="multipart/form-data"')
  })

  it('shows the uploaded photo and a Remove button once avatarKey is set', () => {
    const withAvatar = { ...user, avatarKey: 'abc123-thumb.webp' }
    const html = settingsPage({ brandName: 'Punctual', user: withAvatar, csrf: 'tok', emailDelivery: 'brevo', baseUrl: 'https://punctual.test' })
    expect(html).toContain('/avatars/abc123-thumb.webp')
    expect(html).toContain('action="/dashboard/settings/avatar/delete"')
  })

  it('renders the avatar field error under the photo form', () => {
    const html = settingsPage({
      brandName: 'Punctual',
      user,
      csrf: 'tok', emailDelivery: 'brevo', baseUrl: 'https://punctual.test',
      errors: { avatar: 'PNG, JPEG or WebP images only' },
    })
    expect(html).toContain('PNG, JPEG or WebP images only')
  })
})

const page = (u: User = user) =>
  settingsPage({ brandName: 'Punctual', user: u, csrf: 'tok', emailDelivery: 'brevo', baseUrl: 'https://punctual.test/' })

/**
 * A host who never filled in their name shipped a booking page headed by
 * whatever `defaultNameFrom` made of their email — and the settings page
 * hid that behind an initials badge borrowed from the slug.
 */
describe('settingsPage identity', () => {
  it('requires a name and says what it is for', () => {
    const html = page()
    const nameInput = html.slice(html.indexOf('<input id="name"'), html.indexOf('>', html.indexOf('<input id="name"')))
    expect(nameInput).toContain(' required')
    expect(nameInput).toContain('placeholder="Your name, as guests will see it"')
  })

  it('shows the sign-in address read-only, and says it cannot be changed here', () => {
    const html = page()
    expect(html).toContain('Signed in as <code>grace@example.com</code>')
    expect(html).toContain('The sign-in address can&rsquo;t be changed here.')
    expect(html).not.toContain('name="email"')
  })

  it('renders a neutral ring, not the slug initial, when the name is blank', () => {
    const html = page({ ...user, name: '' })
    expect(html).not.toContain('>G<')
    expect(html).toContain('>?</div>')
    const badge = html.slice(html.lastIndexOf('<div aria-hidden="true"', html.indexOf('>?</div>')), html.indexOf('>?</div>'))
    expect(badge).toContain('var(--pu-paper-dim)')
    expect(badge).not.toContain('var(--pu-green-700)')
  })
})

describe('settingsPage structure', () => {
  it('lifts the title and lede above the cards, like Calendars and API keys', () => {
    const html = page()
    const h1 = html.indexOf('<h1>Settings</h1>')
    const firstCard = html.indexOf('<section class="pu-card"')
    expect(h1).toBeGreaterThan(-1)
    expect(h1).toBeLessThan(firstCard)
  })

  it('warns about the slug change in the warn tint, briefly, and links the live booking page', () => {
    const html = page()
    expect(html).toContain('pu-callout pu-callout-warn')
    expect(html).toContain('redirect from <code>/grace</code>')
    expect(html).not.toContain('role="alert" class="pu-callout"')
    expect(html).toContain('href="https://punctual.test/grace">View your booking page</a>')
  })
})
