/**
 * The `BlobCache` port over Workers KV — same physical namespace as
 * `createKvCache` (kv.ts), a different key prefix, raw bytes instead of JSON.
 *
 * See the `BlobCache` doc comment in ports.ts for why this is a second port
 * rather than reusing `Cache`: this holds rendered OG card PNGs (CCC-496),
 * which are bytes, not JSON-serializable values, and JSON-encoding a PNG
 * through `Cache.put` would bloat it several times over for no reason.
 *
 * Never put booking or hold data through this adapter either — same
 * ADR-0006 §1 reasoning as kv.ts: KV is eventually consistent, and those are
 * exactly the writes a user checks immediately.
 */

import type { BlobCache } from '../../ports.js'

/** Same floor as kv.ts — Cloudflare KV rejects an `expirationTtl` below 60s. */
const MIN_TTL_SECONDS = 60

export function createKvBlobCache(kv: KVNamespace): BlobCache {
  return {
    async get(key: string): Promise<Uint8Array | null> {
      const buf = await kv.get(key, 'arrayBuffer')
      return buf ? new Uint8Array(buf) : null
    },

    async put(key: string, value: Uint8Array, ttlSeconds: number): Promise<void> {
      await kv.put(key, value, {
        expirationTtl: Math.max(MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
      })
    },
  }
}
