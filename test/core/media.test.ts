/**
 * Avatar/logo upload rules — content-type allowlist, size cap, and
 * content-addressed key derivation. Pure, so it runs without R2 or the
 * Workers runtime; the actual upload/serve routes are covered under
 * test/workers/avatars.test.ts.
 */

import { describe, expect, it } from 'vitest'
import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  deriveBlobKey,
  isAllowedImageType,
  thumbKeyFor,
} from '../../src/core/domain/media.js'

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
