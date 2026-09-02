import { describe, expect, it } from 'vitest'
import { docsApiPage, docsIndexPage, docsMcpPage, docsSelfHostingPage } from '../../src/http/pages/docs.js'

const opts = { brandName: 'Punctual', baseUrl: 'https://example.test' }

/**
 * /docs used to be a landing stub whose four sections each linked
 * straight out to a raw GitHub file. These tests check that the shell
 * (nav, footer) is consistent across every docs page and that each page's
 * content is real and specific rather than a placeholder.
 */
describe('docs nav', () => {
  const pages = [
    { name: 'index', html: docsIndexPage(opts), path: '/docs' },
    { name: 'self-hosting', html: docsSelfHostingPage(opts), path: '/docs/self-hosting' },
    { name: 'api', html: docsApiPage(opts), path: '/docs/api' },
    { name: 'mcp', html: docsMcpPage(opts), path: '/docs/mcp' },
  ]

  it.each(pages)('$name page links to all four docs pages', ({ html }) => {
    expect(html).toContain('href="/docs"')
    expect(html).toContain('href="/docs/self-hosting"')
    expect(html).toContain('href="/docs/api"')
    expect(html).toContain('href="/docs/mcp"')
  })

  it.each(pages)('$name page marks its own nav entry aria-current="page"', ({ html, path }) => {
    const marker = `href="${path}" aria-current="page"`
    expect(html).toContain(marker)
  })

  it.each(pages)('$name page includes the shared footer', ({ html }) => {
    expect(html).toContain('pu-landing-footer')
    expect(html).toContain('href="https://github.com/CCCrafts/punctual"')
  })

  it.each(pages)('$name page has no lorem ipsum placeholder text', ({ html }) => {
    expect(html.toLowerCase()).not.toContain('lorem ipsum')
  })
})

describe('docsIndexPage', () => {
  it('links out to the three sub-pages, not straight to GitHub source files', () => {
    const html = docsIndexPage(opts)
    // The whole point of that change: these used to be the only links on the
    // page, pointing at raw GitHub blobs instead of Punctual's own domain.
    expect(html).not.toContain('/blob/main/docs/self-hosting.md')
    expect(html).not.toContain('/blob/main/src/http/api/rest.ts')
    expect(html).not.toContain('/blob/main/src/http/mcp/server.ts')
    expect(html).toContain('Self-hosting')
    expect(html).toContain('REST API')
    expect(html).toContain('MCP server')
  })
})

describe('docsSelfHostingPage', () => {
  const html = docsSelfHostingPage(opts)

  it('has the real quickstart commands, not a paraphrase', () => {
    expect(html).toContain('git clone https://github.com/CCCrafts/punctual.git')
    expect(html).toContain('npx wrangler d1 create punctual')
    expect(html).toContain('npx wrangler kv namespace create CACHE')
    expect(html).toContain('npm run migrate')
    expect(html).toContain('npm run deploy')
  })

  it('names both required secrets', () => {
    expect(html).toContain('ENCRYPTION_KEY_V1')
    expect(html).toContain('SIGNING_KEY')
  })

  it('covers connecting both calendar providers', () => {
    expect(html).toContain('Google')
    expect(html).toContain('Microsoft')
    expect(html).toContain('GOOGLE_CLIENT_ID')
    expect(html).toContain('MICROSOFT_CLIENT_ID')
  })

  it('renders code blocks with the .pu-pre class for code styling', () => {
    expect(html).toContain('<pre class="pu-pre">')
  })

  it('links back to the canonical guide on GitHub', () => {
    expect(html).toContain('docs/self-hosting.md')
  })
})

describe('docsApiPage', () => {
  const html = docsApiPage(opts)

  it('documents the real endpoints with method and path', () => {
    expect(html).toContain('/api/v1/event-types')
    expect(html).toContain('/api/v1/availability')
    expect(html).toContain('/api/v1/slots')
    expect(html).toContain('/api/v1/bookings')
    expect(html).toContain('/api/v1/bookings/:id/cancel')
    expect(html).toContain('/api/v1/bookings/:id/reschedule')
    expect(html).toContain('/api/v1/webhooks')
  })

  it('documents bearer key auth and scopes', () => {
    expect(html).toContain('Authorization: Bearer pk_')
    expect(html).toContain('read')
    expect(html).toContain('write')
  })

  it('documents the RFC 7807 problem+json error shape', () => {
    expect(html).toContain('application/problem+json')
    expect(html).toContain('urn:punctual:problem:invalid-request')
  })

  it('gives a real, copyable curl example', () => {
    expect(html).toContain('curl https://example.test/api/v1/bookings')
    expect(html).toContain('guestEmail')
  })
})

describe('docsMcpPage', () => {
  const html = docsMcpPage(opts)

  it('lists all five real MCP tools by name', () => {
    expect(html).toContain('list_event_types')
    expect(html).toContain('get_available_slots')
    expect(html).toContain('create_booking')
    expect(html).toContain('reschedule_booking')
    expect(html).toContain('cancel_booking')
  })

  it('documents the supported protocol versions', () => {
    expect(html).toContain('2025-11-25')
    expect(html).toContain('2025-06-18')
    expect(html).toContain('2025-03-26')
  })

  it('documents that authority is scoped to the API key', () => {
    expect(html).toContain('Authorization: Bearer pk_')
    expect(html).toContain('scopes')
  })
})
