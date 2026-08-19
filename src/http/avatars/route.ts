/**
 * `GET /avatars/:key` — host avatars and team logos, streamed from
 * R2 through the Worker's own origin rather than a public R2 URL, so cache
 * behaviour and invalidation stay under this app's control (same reasoning as
 * the OG card route, `src/http/og/route.ts`).
 *
 * Keys are content-addressed (`core/domain/media.ts`), which is what makes
 * the aggressive `immutable` cache-control below safe: the bytes behind a
 * given key never change, only which key a user/team row points at.
 */

import { Hono } from 'hono'
import type { EnginePorts } from '../../ports.js'

type Env = Record<string, unknown>

/**
 * `{sha256 hex}-thumb.webp` — the derived thumbnail only, never the
 * original an upload also stores under `{sha256 hex}.{png|jpg|webp}` (see
 * `deriveBlobKey`/`thumbKeyFor`). The original is never served: it can carry
 * EXIF (GPS, device serial, capture time) a host never agreed to publish —
 * only the re-encoded, metadata-free thumbnail is meant to be public. This
 * pattern also keeps the route from being usable as a generic "fetch any
 * key" probe against the bucket.
 */
const KEY_PATTERN = /^[a-f0-9]{64}-thumb\.webp$/

// A year, immutable: the key IS the hash of the bytes, so nothing this route
// serves can ever change under a fixed key (contrast the OG card route's
// 1-hour TTL, which caches a RENDER that can go stale as the underlying data
// changes).
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

export function buildAvatarRoutes(ports: EnginePorts): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  app.get('/avatars/:key', async (c) => {
    const key = c.req.param('key')
    if (!KEY_PATTERN.test(key)) return c.notFound()

    const object = await ports.blobStorage.get(key)
    if (!object) return c.notFound()

    return c.body(object.bytes as unknown as ArrayBuffer, 200, {
      'content-type': object.contentType,
      'cache-control': CACHE_CONTROL,
    })
  })

  return app
}
