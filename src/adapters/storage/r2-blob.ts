/**
 * The `BlobStorage` port over R2: host avatars and team logos.
 *
 * A separate bucket from the `CACHE` KV namespace `Cache`/`BlobCache` share —
 * see the `BlobStorage` doc comment in `ports.ts` for why user-uploaded,
 * authoritative content is a different trust category from freeBusy caching
 * and rendered OG cards, and belongs in durable object storage rather than
 * KV.
 */

import type { BlobStorage } from '../../ports.js'

export function createR2BlobStorage(bucket: R2Bucket): BlobStorage {
  return {
    async get(key: string) {
      const obj = await bucket.get(key)
      if (!obj) return null
      const bytes = new Uint8Array(await obj.arrayBuffer())
      return { bytes, contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream' }
    },

    async put(key: string, value: Uint8Array, contentType: string) {
      await bucket.put(key, value, { httpMetadata: { contentType } })
    },
  }
}
