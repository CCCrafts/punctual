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

/**
 * Pixel budget for a decode. `@cf-wasm/photon` decodes straight to raw RGBA
 * in wasm linear memory — a highly compressible image (a solid-color PNG,
 * say) can stay tiny on disk while decoding to gigabytes, so `MAX_UPLOAD_BYTES`
 * alone does not bound decode memory. `resizeToSquareThumbnail` holds two
 * same-scale buffers at once for most of its work (the decoded image and its
 * square crop — the resize step's own output is tiny, THUMB_DIMENSION on a
 * side, and all three are freed together only at the very end), so the real
 * peak is roughly `2 * pixels * 4` bytes (RGBA) against a Worker's 128 MB
 * isolate cap. 12,000,000 — a 4000x3000 photo, the single most common phone-
 * camera default resolution — peaks at ~96 MB, leaving ~32 MB of headroom
 * for isolate/wasm overhead either side of the decode.
 */
export const MAX_DECODED_PIXELS = 12_000_000

/**
 * Reads width/height from just the file header — PNG's IHDR chunk, a JPEG's
 * first SOF marker, or a WebP's VP8/VP8L/VP8X chunk — without decoding a
 * single pixel, so a decompression-bomb upload can be rejected before
 * `resizeToSquareThumbnail` ever allocates decode memory for it. Returns
 * `null` for anything that doesn't parse as a well-formed header of the
 * given type; the caller treats that the same as "too large" — a header
 * malformed enough to fail this SHOULD also fail photon's real decode, so
 * this is not narrowing what content is accepted, only when memory for it
 * gets allocated.
 */
export function readImageDimensions(
  bytes: Uint8Array,
  contentType: AllowedImageType,
): { width: number; height: number } | null {
  switch (contentType) {
    case 'image/png':
      return readPngDimensions(bytes)
    case 'image/jpeg':
      return readJpegDimensions(bytes)
    case 'image/webp':
      return readWebpDimensions(bytes)
  }
}

/** 8-byte signature, then the first chunk is always IHDR: 4-byte length, "IHDR", 4-byte width, 4-byte height (big-endian). */
function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null // "IHDR"
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
}

/**
 * Scans marker segments from the SOI (0xFFD8) for the first Start-Of-Frame
 * marker (0xC0-0xCF, excluding the reserved/non-frame 0xC4 DHT, 0xC8 JPG,
 * 0xCC DAC) and reads its 2-byte height then 2-byte width (big-endian,
 * right after the segment's 2-byte length and 1-byte sample precision).
 * Every other segment is skipped by its own declared length, so this never
 * touches entropy-coded scan data. Bounded iteration count: a marker scan
 * over attacker-controlled bytes must terminate even on malformed input.
 */
function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  const STANDALONE = new Set([0xd8, 0xd9, 0x01])
  let offset = 2
  for (let iterations = 0; iterations < 1000 && offset + 1 < bytes.length; iterations++) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    if (marker === 0xda) return null // Start of scan — no SOF seen before entropy data, malformed for our purposes.
    if (STANDALONE.has(marker) || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (offset + 3 >= bytes.length) return null
    const segmentLength = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 >= bytes.length) return null
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!
      return { width, height }
    }
    offset += 2 + segmentLength
  }
  return null
}

/** 12-byte "RIFF"+size+"WEBP" header, then one chunk: VP8X (extended), VP8L (lossless) or VP8 (lossy) — each packs width/height differently. */
function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF') return null
  if (String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return null
  const fourCc = String.fromCharCode(...bytes.slice(12, 16))
  const chunk = bytes.slice(20)

  if (fourCc === 'VP8X') {
    // flags(1) + reserved(3), then 24-bit LE (canvas width - 1), 24-bit LE (canvas height - 1).
    const width = (chunk[4]! | (chunk[5]! << 8) | (chunk[6]! << 16)) + 1
    const height = (chunk[7]! | (chunk[8]! << 8) | (chunk[9]! << 16)) + 1
    return { width, height }
  }
  if (fourCc === 'VP8L') {
    // Signature byte (0x2F), then 14 bits (width - 1) + 14 bits (height - 1), packed little-endian.
    if (chunk[0] !== 0x2f) return null
    const b1 = chunk[1]!,
      b2 = chunk[2]!,
      b3 = chunk[3]!,
      b4 = chunk[4]!
    const width = (b1 | ((b2 & 0x3f) << 8)) + 1
    const height = ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) + 1
    return { width, height }
  }
  if (fourCc === 'VP8 ') {
    // 3-byte frame tag (chunk[0..3)), then the 3-byte start code
    // 0x9d 0x01 0x2a at chunk[3..6), then two 14-bit little-endian
    // dimensions at chunk[6..8) and chunk[8..10).
    if (chunk[3] !== 0x9d || chunk[4] !== 0x01 || chunk[5] !== 0x2a) return null
    const width = (chunk[6]! | (chunk[7]! << 8)) & 0x3fff
    const height = (chunk[8]! | (chunk[9]! << 8)) & 0x3fff
    return { width, height }
  }
  return null
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
  return out
}
