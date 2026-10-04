import { describe, expect, it } from 'vitest'
import { createZoneAnalytics, type ZoneTraffic } from '../../src/adapters/insights/zone-analytics.js'
import type { Cache } from '../../src/ports.js'

function memoryCache(): Cache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    async get<T>(key: string) { return (store.get(key) as T) ?? null },
    async put<T>(key: string, value: T) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

const sample = {
  data: { viewer: { zones: [{
    days: [{ count: 300, dimensions: { date: '2026-09-20' } }, { count: 450, dimensions: { date: '2026-09-21' } }],
    paths: [{ count: 500, dimensions: { clientRequestPath: '/' } }, { count: 120, dimensions: { clientRequestPath: '/serge/30min' } }],
    countries: [{ count: 600, dimensions: { clientCountryName: 'US' } }],
    agents: [{ count: 400, dimensions: { userAgent: 'facebookexternalhit/1.1' } }],
  }] } },
}

describe('zone analytics', () => {
  it('is unconfigured without a zone id or token, and answers null', async () => {
    expect(createZoneAnalytics({ host: 'punctual.sh' }).configured).toBe(false)
    expect(await createZoneAnalytics({ host: 'punctual.sh', zoneId: 'z' }).traffic()).toBeNull()
  })

  it('asks GraphQL for the host, browsers only, over fourteen days, and shapes the answer; then serves it from cache', async () => {
    const calls: Array<{ auth: string; body: { query: string; variables: Record<string, string> } }> = []
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ auth: String((init?.headers as Record<string, string>)['authorization']), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(sample), { status: 200 })
    }) as typeof globalThis.fetch
    const cache = memoryCache()
    const now = Date.UTC(2026, 9, 4, 12)
    const port = createZoneAnalytics({ host: 'punctual.sh', zoneId: 'zone_1', apiToken: 'tok', cache, fetch: fetchImpl, now: () => now })
    expect(port.configured).toBe(true)
    const t = (await port.traffic()) as ZoneTraffic
    expect(calls).toHaveLength(1)
    expect(calls[0]!.auth).toBe('Bearer tok')
    expect(calls[0]!.body.variables).toEqual({ zone: 'zone_1', since: new Date(now - 14 * 86_400_000).toISOString(), until: new Date(now).toISOString() })
    expect(calls[0]!.body.query).toContain('requestSource:"eyeball"')
    expect(calls[0]!.body.query).toContain('clientRequestHTTPHost:"punctual.sh"')
    expect(calls[0]!.body.query).not.toMatch(/clientRefererHost|clientASNDescription/)
    expect(t).toEqual({
      since: '2026-09-20', until: '2026-10-04', total: 750,
      days: [{ day: '2026-09-20', requests: 300 }, { day: '2026-09-21', requests: 450 }],
      paths: [{ path: '/', requests: 500 }, { path: '/serge/30min', requests: 120 }],
      countries: [{ country: 'US', requests: 600 }],
      agents: [{ agent: 'facebookexternalhit/1.1', requests: 400 }],
    })
    await port.traffic()
    expect(calls).toHaveLength(1)
    expect(cache.store.size).toBe(1)
  })

  it('answers null — never throws — on a refusal, a GraphQL error, or a network failure', async () => {
    const refused = createZoneAnalytics({ host: 'h', zoneId: 'z', apiToken: 't', fetch: (async () => new Response('no', { status: 403 })) as typeof globalThis.fetch })
    expect(await refused.traffic()).toBeNull()
    const gqlError = createZoneAnalytics({ host: 'h', zoneId: 'z', apiToken: 't', fetch: (async () => new Response(JSON.stringify({ errors: [{ message: 'does not have permission' }] }), { status: 200 })) as typeof globalThis.fetch })
    expect(await gqlError.traffic()).toBeNull()
    const down = createZoneAnalytics({ host: 'h', zoneId: 'z', apiToken: 't', fetch: (async () => { throw new Error('offline') }) as unknown as typeof globalThis.fetch })
    expect(await down.traffic()).toBeNull()
  })
})
