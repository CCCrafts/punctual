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
    const html = settingsPage({ brandName: 'Punctual', user, csrf: 'tok' })
    expect(html).toContain('pu-callout')
    // .pu-err is still fine elsewhere on the page (an actual field error).
    const calloutSection = html.slice(html.indexOf('pu-callout'), html.indexOf('</div>', html.indexOf('pu-callout')))
    expect(calloutSection).not.toContain('pu-err')
  })

  it('still names the current slug in the warning text', () => {
    const html = settingsPage({ brandName: 'Punctual', user, csrf: 'tok' })
    expect(html).toContain('<code>grace</code>')
  })
})

describe('settingsPage photo section', () => {
  it('shows an initials badge and no Remove button when nothing is uploaded', () => {
    const html = settingsPage({ brandName: 'Punctual', user, csrf: 'tok' })
    expect(html).toContain('>G<') // initial of "Grace Hopper"
    expect(html).not.toContain('/dashboard/settings/avatar/delete')
    expect(html).toContain('action="/dashboard/settings/avatar"')
    expect(html).toContain('enctype="multipart/form-data"')
  })

  it('shows the uploaded photo and a Remove button once avatarKey is set', () => {
    const withAvatar = { ...user, avatarKey: 'abc123-thumb.webp' }
    const html = settingsPage({ brandName: 'Punctual', user: withAvatar, csrf: 'tok' })
    expect(html).toContain('/avatars/abc123-thumb.webp')
    expect(html).toContain('action="/dashboard/settings/avatar/delete"')
  })

  it('renders the avatar field error under the photo form', () => {
    const html = settingsPage({
      brandName: 'Punctual',
      user,
      csrf: 'tok',
      errors: { avatar: 'PNG, JPEG or WebP images only' },
    })
    expect(html).toContain('PNG, JPEG or WebP images only')
  })
})
