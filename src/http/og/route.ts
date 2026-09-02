/**
 * `GET /og/:userSlug/:eventSlug.png` — the per-booking-page OG card.
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
import type { OgAvatar } from './card.js'
import { resolveHosts } from '../../core/domain/hosts.js'
import { joinNames } from '../pages/booking.js'
import { toPng } from '../../adapters/image/resize.js'

type Env = Record<string, unknown>

/** Marketing content, not booking data — an hour of staleness is fine (mirrors ADR-0006 §1's freeBusy TTL philosophy). */
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
    const { host, eventType, team } = ctx

    // Who the meeting is with — the resolved hosts (core/domain/hosts.ts),
    // so the card and the page agree. Collective names them; round robin
    // names the team, because a listing must never promise one person
    // (ADR-0004 §5). The cache key carries the host ids and avatar keys:
    // a new photo or a changed host list must not serve a stale card for
    // an hour.
    const hosts = await resolveHosts(repos, eventType, host)
    const names = hosts.map((h) => h.user.name || h.user.slug)
    const subject = !team ? (names[0] ?? host.name) || host.slug : cardSubject(names, team.name, eventType.schedulingType)
    // Hashed, not concatenated: KV rejects keys over 512 bytes, and six
    // hosts with photos would pass that — silently, since the cache calls
    // below swallow errors, leaving every crawler hit to re-render.
    const faceKeys = hosts.map((h) => `${h.user.id}:${h.user.avatarKey ?? '-'}`).join(',')
    const cacheKey = `og:v2:${userSlug}:${eventSlug}:${await ports.crypto.hash(faceKeys)}`

    const cached = await safeGet(ports, cacheKey)
    if (cached) return pngResponse(c, cached)

    const png = await renderJoining(cacheKey, async () => {
      const now = ports.clock.now()
      const timeLabel = `${formatInZone(now, host.tz, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })} ${offsetLabel(now, host.tz)}`
      const shown = hosts.slice(0, 3)
      const avatars: OgAvatar[] = []
      for (const h of shown) {
        avatars.push({
          ...(await avatarDataUri(ports, h.user.avatarKey)),
          initial: (h.user.name || h.user.slug).trim().charAt(0).toUpperCase() || '?',
        })
      }
      return renderOgCard({
        hostName: subject,
        brandName: ports.config.brandName,
        durationMinutes: eventType.durationMinutes,
        timeLabel,
        avatars,
        extraCount: Math.max(0, hosts.length - shown.length),
      })
    })
    if (!png) return c.redirect(DEFAULT_CARD_PATH, 302)

    await safePut(ports, cacheKey, png)
    return pngResponse(c, png)
  })

  return app
}

/** "with …" must fit the card's label cap (safety.ts); this is the same number, minus the word. */
const MAX_SUBJECT_LENGTH = 35

/**
 * Who a team card says the meeting is with. Round robin: the team, never
 * one person (ADR-0004 §5). Collective: the hosts by full name, then by
 * first name, then two names and a count, then the team — the first that
 * fits the label cap, so three long names degrade to something true
 * rather than to the static default card.
 */
function cardSubject(names: string[], teamName: string, schedulingType: string): string {
  const team = `the ${teamName} team`
  if (schedulingType !== 'collective' || names.length === 0) return team
  const first = names.map((n) => n.split(/\s+/)[0] ?? n)
  const candidates = [
    joinNames(names),
    joinNames(first),
    names.length > 2 ? `${first.slice(0, 2).join(', ')} and ${names.length - 2} more` : '',
    team,
  ]
  return candidates.find((c) => c !== '' && c.length <= MAX_SUBJECT_LENGTH) ?? team
}

/**
 * The host's avatar thumbnail as a PNG data URI for satori, or nothing —
 * the initial takes over. Thumbnails are WebP in R2 (see avatars/route.ts)
 * and resvg decodes PNG/JPEG only, hence the re-encode. Any failure —
 * missing object, undecodable bytes — is the initials fallback, never a
 * failed card.
 */
async function avatarDataUri(ports: EnginePorts, key: string | null): Promise<{ src?: string }> {
  if (!key) return {}
  try {
    const object = await ports.blobStorage.get(key)
    if (!object) return {}
    const png = toPng(object.bytes)
    if (!png) return {}
    let binary = ''
    for (let i = 0; i < png.length; i++) binary += String.fromCharCode(png[i]!)
    return { src: `data:image/png;base64,${btoa(binary)}` }
  } catch {
    return {}
  }
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
