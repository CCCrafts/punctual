import { describe, expect, it } from 'vitest'
import { calendlyAlternativePage, landingPage } from '../../src/http/pages/landing.js'
import { docsIndexPage } from '../../src/http/pages/docs.js'

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

/**
 * The footer's operator line uses the same EngineConfig.legalOperator source
 * as /privacy and /terms — unset by default, so a self-hosted deployment run
 * by nobody-in-particular doesn't name this repo's owner as its own operator.
 */
describe('footer operator line', () => {
  const base = { brandName: 'Punctual', baseUrl: 'https://example.test' }

  it('omits the operator line when unset', () => {
    // Not a bare "not.toContain('CCCrafts')": the default GitHub link
    // (github.com/CCCrafts/punctual) legitimately contains that substring
    // regardless of the operator setting.
    expect(landingPage(base)).not.toContain('Creative Content Crafts (CCCrafts)')
    expect(docsIndexPage(base)).not.toContain('Creative Content Crafts (CCCrafts)')
  })

  it('shows the configured operator on both the landing and docs footers', () => {
    const opts = { ...base, operator: 'Creative Content Crafts (CCCrafts)' }
    expect(landingPage(opts)).toContain('Creative Content Crafts (CCCrafts)')
    expect(docsIndexPage(opts)).toContain('Creative Content Crafts (CCCrafts)')
  })
})

/**
 * The hero clock is decorative and JS-only (a live tick can't be
 * server-rendered) — it must never gate on `prefers-reduced-motion` in the
 * script itself, only in CSS. Gating in JS would leave the element at its
 * pre-animation `opacity:0` forever for exactly the users who need it to
 * just appear (see styles.ts's `.pu-hero-clock` / `.pu-in` rules).
 */
describe('landingPage hero clock', () => {
  const opts = { brandName: 'Punctual', baseUrl: 'https://example.test' }

  it('renders the clock element and always applies the entrance class', () => {
    const html = landingPage(opts)
    expect(html).toContain('id="pu-hero-clock"')
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'))
    expect(script).toContain("classList.add('pu-in')")
    // The gate belongs in CSS (styles.ts), not here — a `matchMedia` check
    // guarding `classList.add` would leave the clock at its pre-animation
    // opacity:0 forever under reduced motion instead of just appearing.
    expect(script).not.toContain('matchMedia')
  })
})

describe('calendlyAlternativePage', () => {
  const opts = { brandName: 'Punctual', baseUrl: 'https://example.test' }

  it('renders a comparison table covering license and self-hosting', () => {
    const html = calendlyAlternativePage(opts)
    expect(html).toContain('MIT, open source')
    expect(html).toContain('Self-hosting')
    expect(html).toContain('Calendly')
  })

  it('is linked from the landing page footer', () => {
    expect(landingPage(opts)).toContain('href="/calendly-alternative"')
  })

  it('describes Calendly pricing qualitatively, not with a specific figure', () => {
    // The whole point of a comparison page is that every claim is checkable
    // by the reader — a specific dollar figure for a competitor is the one
    // claim that goes stale and gets caught, so the page must stick to
    // qualitative, durable claims (see calendlyAlternativePage's doc comment).
    expect(calendlyAlternativePage(opts)).toContain('Seat-based subscription')
  })
})
