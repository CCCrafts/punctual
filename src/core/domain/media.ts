/**
 * Avatar/team-logo upload rules: the allowed image types, the size
 * cap, and content-addressed key derivation.
 *
 * Pure — no R2, no Workers imports, so it runs in `test/core`. `deriveBlobKey`
 * uses `crypto.subtle`, a global in both Workers and Node 20+ (same reasoning
 * as `adapters/crypto/webcrypto.ts`'s header comment), which is what keeps
 * this file import-free rather than needing an adapter of its own.
 */

/** Images only. Covers every common export path (phone camera, screenshot, design tool) without inviting SVG (script-executable) or GIF (unbounded frame count). */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

/**
 * 5 MB. Generous for a profile photo or a logo exported from a phone camera
 * or a marketing tool, while still bounding two costs: the memory a
 * server-side resize needs (`@cf-wasm/photon` decodes the whole image to raw
 * RGBA pixels — a few MB of encoded JPEG can be tens of MB decoded, and a
 * Worker has a 128 MB cap) and the R2 storage a self-hoster never signed up
 * to run a media library on.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

const EXTENSION_FOR: Record<AllowedImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function isAllowedImageType(contentType: string): contentType is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType)
}

/**
 * SHA-256 of the raw bytes, hex, plus the type's extension.
 *
 * Content-addressed on purpose: re-uploading identical bytes (the same host
 * re-saving their profile photo, or two hosts using the same stock logo)
 * resolves to the same key, so storage never grows on a re-upload and the
 * upload route can skip the resize entirely on a hit — see
 * `dashboard-routes.ts`.
 */
export async function deriveBlobKey(bytes: Uint8Array, contentType: AllowedImageType): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `${toHex(new Uint8Array(digest))}.${EXTENSION_FOR[contentType]}`
}

/**
 * The derived thumbnail's key for a given original key — one deterministic
 * transform, so the upload route and every renderer agree on it without a
 * second stored column. `User.avatarKey`/`Team.logoKey` hold THIS key (what
 * is actually displayed); the original stays in R2 under its own key,
 * recoverable by reversing this suffix if a future feature needs the
 * full-resolution source, but nothing in this pass links to it directly.
 */
export function thumbKeyFor(originalKey: string): string {
  return `${originalKey.replace(/\.[^./]+$/, '')}-thumb.webp`
}

/** The square pixel size every avatar/logo thumbnail is resized to. */
export const THUMB_DIMENSION = 256
export const THUMB_CONTENT_TYPE = 'image/webp'

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
  return out
}
