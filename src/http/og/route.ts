/**
 * `GET /og/:userSlug/:eventSlug.png` — the per-booking-page OG card (CCC-496).
 *
 * Crawler-only traffic (Slack/X/LinkedIn/Telegram/iMessage unfurlers), never
 * the booking page's own render path — so an on-demand render-and-cache-on-
 * first-hit is the right shape: the booking page itself never waits on this.
 *
 * Every failure mode — host/event not found, the host name or time label
 * isn't safely renderable, satori/resvg throws — falls back to the static
 * `assets/og/default.png`, served by the `[assets]` binding outside the
 * Worker entirely. A broken card is worse than a generic one.
 */

import { Hono, type Context } from 'hono'
import type { EnginePorts, RequestScope } from '../../ports.js'
import { formatInZone, offsetLabel } from '../../core/time/zone.js'
import { renderOgCard } from './render.js'

type Env = Record<string, unknown>

/** Marketing content, not booking data — an hour of staleness is fine (CCC-496, mirrors ADR-0006 §1's freeBusy TTL philosophy). */
const CACHE_TTL_SECONDS = 60 * 60
const DEFAULT_CARD_PATH = '/og/default.png'
const PNG_SUFFIX = '.png'

/**
 * In-flight renders, keyed by cache key, so concurrent requests for the same
 * card share one render instead of each paying satori+resvg's cost. A fresh
 * link posted to Slack/X/LinkedIn/Telegram/iMessage gets unfurled by several
 * of those within the same second, all racing an empty cache — exactly the
 * case this closes. Isolate-local only (Workers has no cross-isolate memory),
 * so it is a best-effort thinning, not a correctness guarantee — the cache
 * write below is still what makes a second isolate's hit free.
 */
const inFlight = new Map<string, Promise<Uint8Array | null>>()

export function buildOgRoutes(ports: EnginePorts): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  const publicScope: RequestScope = { consistency: 'unconstrained' }

  app.get('/og/:userSlug/:eventSlugPng', async (c) => {
    const { userSlug, eventSlugPng } = c.req.param()
    if (!eventSlugPng.endsWith(PNG_SUFFIX)) return c.notFound()
    const eventSlug = eventSlugPng.slice(0, -PNG_SUFFIX.length)
    if (eventSlug === '') return c.notFound()

    const repos = ports.repositories(publicScope)
    const ctx = await repos.eventTypes.bookingPageContext(userSlug, eventSlug)
    if (!ctx) return c.notFound()
    const { host, eventType } = ctx

    const cacheKey = `og:v1:${userSlug}:${eventSlug}`
    const cached = await safeGet(ports, cacheKey)
    if (cached) return pngResponse(c, cached)

    const png = await renderJoining(cacheKey, async () => {
      const now = ports.clock.now()
      const timeLabel = `${formatInZone(now, host.tz, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })} ${offsetLabel(now, host.tz)}`

      return renderOgCard({
        hostName: host.name || host.slug,
        brandName: ports.config.brandName,
        durationMinutes: eventType.durationMinutes,
        timeLabel,
      })
    })
    if (!png) return c.redirect(DEFAULT_CARD_PATH, 302)

    await safePut(ports, cacheKey, png)
    return pngResponse(c, png)
  })

  return app
}

/** Joins a concurrent request for `key` onto an already-running render rather than starting a second one. */
function renderJoining(key: string, render: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = render().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

function pngResponse(c: Context<{ Bindings: Env }>, bytes: Uint8Array): Response {
  return c.body(bytes as unknown as ArrayBuffer, 200, {
    'content-type': 'image/png',
    'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
  })
}

/** KV being briefly unavailable must degrade to "render it again", never a 500 on a crawler-only route. */
async function safeGet(ports: EnginePorts, key: string): Promise<Uint8Array | null> {
  try {
    return await ports.blobCache.get(key)
  } catch {
    return null
  }
}

async function safePut(ports: EnginePorts, key: string, value: Uint8Array): Promise<void> {
  try {
    await ports.blobCache.put(key, value, CACHE_TTL_SECONDS)
  } catch {
    // Best-effort — a successful render must still be served even if the cache write fails.
  }
}
