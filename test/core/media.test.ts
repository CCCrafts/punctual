/**
 * Avatar/logo upload rules — content-type allowlist, size cap, and
 * content-addressed key derivation. Pure, so it runs without R2 or the
 * Workers runtime; the actual upload/serve routes are covered under
 * test/workers/avatars.test.ts.
 */

import { describe, expect, it } from 'vitest'
import {
  ALLOWED_IMAGE_TYPES,
  MAX_DECODED_PIXELS,
  MAX_UPLOAD_BYTES,
  deriveBlobKey,
  isAllowedImageType,
  readImageDimensions,
  thumbKeyFor,
} from '../../src/core/domain/media.js'

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// Real encoder output (ImageMagick), not hand-crafted bytes — proves the
// header parser agrees with what a real PNG/JPEG/WebP encoder actually
// produces, not just with a spec reading.
const REAL_PNG_6X4 =
  'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAEAQMAAACXytwAAAAAA1BMVEUzVe4BKQB9AAAAC0lEQVQI12NggAAAAAgAAS8g3TEAAAAASUVORK5CYII='
const REAL_JPEG_37X23 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAXACUDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmwCcaeAAAAAAAAAA/9k='
const REAL_WEBP_50X30 =
  'UklGRkgAAABXRUJQVlA4IDwAAAAwAwCdASoyAB4APpFIn0ulpCKhpAgAsBIJZwDR+As+/lc4AP7aJv1xc2RFH/+bA/9vP/BHfDIsak+IAAA='
// Lossless (VP8L) and extended-with-alpha (VP8X) WebP have different chunk
// layouts than lossy VP8 above — each verified against real encoder output
// separately, not assumed to share VP8's byte offsets.
const REAL_WEBP_LOSSLESS_12X9 = 'UklGRh4AAABXRUJQVlA4TBEAAAAvCwACAAdQ1Yr0rv+BiOh/AAA='
const REAL_WEBP_ALPHA_15X11 =
  'UklGRloAAABXRUJQVlA4WAoAAAAQAAAADgAACgAAQUxQSAoAAAABB1DAiAhERP8DVlA4ICoAAACQAQCdASoPAAsAAgA0JaACdLoAA5gA/vD6K/8zR+k30m9D/9wZn1dQAAA='

describe('readImageDimensions', () => {
  it('reads a real PNG (ImageMagick output) from its IHDR chunk', () => {
    expect(readImageDimensions(fromBase64(REAL_PNG_6X4), 'image/png')).toEqual({ width: 6, height: 4 })
  })

  it('reads a real baseline JPEG (ImageMagick output) from its SOF0 marker', () => {
    expect(readImageDimensions(fromBase64(REAL_JPEG_37X23), 'image/jpeg')).toEqual({ width: 37, height: 23 })
  })

  it('reads a real lossy WebP (ImageMagick output) from its VP8 chunk', () => {
    expect(readImageDimensions(fromBase64(REAL_WEBP_50X30), 'image/webp')).toEqual({ width: 50, height: 30 })
  })

  it('reads a real lossless WebP (ImageMagick output) from its VP8L chunk', () => {
    expect(readImageDimensions(fromBase64(REAL_WEBP_LOSSLESS_12X9), 'image/webp')).toEqual({
      width: 12,
      height: 9,
    })
  })

  it('reads a real extended/alpha WebP (ImageMagick output) from its VP8X chunk', () => {
    expect(readImageDimensions(fromBase64(REAL_WEBP_ALPHA_15X11), 'image/webp')).toEqual({
      width: 15,
      height: 11,
    })
  })

  it('returns null for a PNG missing its signature', () => {
    expect(readImageDimensions(new Uint8Array(30), 'image/png')).toBeNull()
  })

  it('returns null for bytes too short to hold a header', () => {
    expect(readImageDimensions(new Uint8Array([1, 2, 3]), 'image/png')).toBeNull()
    expect(readImageDimensions(new Uint8Array([1, 2, 3]), 'image/jpeg')).toBeNull()
    expect(readImageDimensions(new Uint8Array([1, 2, 3]), 'image/webp')).toBeNull()
  })

  it('the decompression-bomb case: a PNG header can claim a huge decode size while the file itself is tiny', () => {
    // A hand-built IHDR claiming 20000x20000 (400,000,000 pixels) — exactly
    // what a real solid-color PNG encoder would also produce for an image
    // that size, verified separately with ImageMagick (`-size 8000x8000`
    // compresses to under 8 KB on disk). This is the case MAX_DECODED_PIXELS
    // exists to catch BEFORE `resizeToSquareThumbnail` decodes it.
    const header = new Uint8Array(24)
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // signature
    header.set([0, 0, 0, 13], 8) // IHDR length
    header.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
    const view = new DataView(header.buffer)
    view.setUint32(16, 20000, false)
    view.setUint32(20, 20000, false)

    const dims = readImageDimensions(header, 'image/png')
    expect(dims).toEqual({ width: 20000, height: 20000 })
    expect(dims!.width * dims!.height).toBeGreaterThan(MAX_DECODED_PIXELS)
  })
})

describe('isAllowedImageType', () => {
  it('accepts every type in the allowlist', () => {
    for (const t of ALLOWED_IMAGE_TYPES) expect(isAllowedImageType(t)).toBe(true)
  })

  it('rejects SVG — script-executable, unlike a raster image', () => {
    expect(isAllowedImageType('image/svg+xml')).toBe(false)
  })

  it('rejects GIF — unbounded frame count', () => {
    expect(isAllowedImageType('image/gif')).toBe(false)
  })

  it('rejects a non-image type entirely', () => {
    expect(isAllowedImageType('application/pdf')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isAllowedImageType('')).toBe(false)
  })
})

describe('deriveBlobKey', () => {
  it('is deterministic for identical bytes and content type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const a = await deriveBlobKey(bytes, 'image/png')
    const b = await deriveBlobKey(bytes, 'image/png')
    expect(a).toBe(b)
  })

  it('differs for different bytes', async () => {
    const a = await deriveBlobKey(new Uint8Array([1, 2, 3]), 'image/png')
    const b = await deriveBlobKey(new Uint8Array([1, 2, 4]), 'image/png')
    expect(a).not.toBe(b)
  })

  it('differs for the same bytes under a different content type — same hash, different extension', async () => {
    const bytes = new Uint8Array([9, 9, 9])
    const png = await deriveBlobKey(bytes, 'image/png')
    const jpg = await deriveBlobKey(bytes, 'image/jpeg')
    expect(png).not.toBe(jpg)
    expect(png.endsWith('.png')).toBe(true)
    expect(jpg.endsWith('.jpg')).toBe(true)
  })

  it('produces a lowercase-hex sha256 plus extension', async () => {
    const key = await deriveBlobKey(new Uint8Array([1, 2, 3]), 'image/webp')
    expect(key).toMatch(/^[a-f0-9]{64}\.webp$/)
  })
})

describe('thumbKeyFor', () => {
  it('replaces the extension with -thumb.webp', () => {
    const original = 'a'.repeat(64) + '.jpg'
    expect(thumbKeyFor(original)).toBe('a'.repeat(64) + '-thumb.webp')
  })

  it('is a pure function of the original key — no dependency on the actual bytes', () => {
    const key = 'b'.repeat(64) + '.png'
    expect(thumbKeyFor(key)).toBe(thumbKeyFor(key))
  })
})

describe('MAX_UPLOAD_BYTES', () => {
  it('is 5 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024)
  })
})
