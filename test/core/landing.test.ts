import { describe, expect, it } from 'vitest'
import { landingPage } from '../../src/http/pages/landing.js'

/**
 * Regression: a fresh or self-hosted deployment has no host/event type
 * seeded yet. `landingPage` used to fall back to a hardcoded demo identity
 * (/serge/30min), which made every such deployment's own homepage embed a
 * 404ing iframe and link to a booking page that doesn't exist. There is no
 * safe default demo — it must come from the deployment's own config, and the
 * page must degrade gracefully without one.
 */
describe('landingPage without a configured demo', () => {
  const opts = { brandName: 'Punctual', baseUrl: 'https://example.test' }

  it('does not embed a live demo iframe', () => {
    const html = landingPage(opts)
    expect(html).not.toContain('embed.js')
    expect(html).not.toContain('Live demo')
  })

  it('does not link to a "see a booking page" CTA', () => {
    const html = landingPage(opts)
    expect(html).not.toContain('See a booking page')
  })
})

describe('landingPage with a configured demo', () => {
  const opts = { brandName: 'Punctual', baseUrl: 'https://example.test', demoPath: '/serge/30min' }

  it('embeds the live demo for the configured host/event', () => {
    const html = landingPage(opts)
    expect(html).toContain('data-user="serge"')
    expect(html).toContain('data-event="30min"')
  })

  it('links the CTA to the same demo path', () => {
    const html = landingPage(opts)
    expect(html).toContain('href="/serge/30min">See a booking page')
  })
})
