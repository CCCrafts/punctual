/**
 * `GET /avatars/:key` — host avatars and team logos (CCC-543), streamed from
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

/** `{sha256 hex}.{png|jpg|webp}` (the original) or `{sha256 hex}-thumb.webp` (the derived thumbnail) — see `deriveBlobKey`/`thumbKeyFor`. Rejecting anything else before it reaches R2 keeps this route from being usable as a generic "fetch any key" probe. */
const KEY_PATTERN = /^[a-f0-9]{64}(-thumb)?\.(png|jpg|webp)$/

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
