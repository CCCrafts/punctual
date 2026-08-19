/**
 * Server-side avatar/logo thumbnail generation (CCC-543), so a derived
 * thumbnail exists by upload time — never computed on the booking-page
 * request path, which has its own <100 ms budget (ADR-0007 §3) and no
 * business decoding and resizing images on it.
 *
 * `@cf-wasm/photon` (Rust `photon-rs` compiled to wasm) is the same category
 * of dependency as satori + resvg-wasm in `src/http/og/render.ts`: Workers has
 * no native raster image-resize primitive, so this is the standard way to get
 * one under `workerd`. Unlike that pair, `@cf-wasm/photon/workerd` inits
 * itself at import time (it does its own wrangler-bundled `.wasm` import and
 * calls `initPhoton.sync` at module scope internally) — nothing here has to.
 *
 * Bundle cost, measured with `npx wrangler deploy --dry-run` (2026-08-19):
 * 1340.94 KiB gzip before this dependency, 1955.57 KiB gzip after — this
 * package adds ~615 KiB compressed (its wasm binary is ~1.5 MB uncompressed),
 * leaving ~1.09 MB of headroom under the ~3 MB Workers free-tier compressed
 * limit. Decode support for all three allowed upload types (PNG, JPEG, WebP)
 * was verified directly against this package's wasm binary before committing
 * to it, not assumed from the `image` crate's changelog.
 */

import { PhotonImage, crop, resize as photonResize, SamplingFilter } from '@cf-wasm/photon/workerd'
import { THUMB_DIMENSION } from '../../core/domain/media.js'

/**
 * Decodes `bytes`, center-crops to a square (cover, not stretch — an avatar
 * or logo that isn't already square must not come out squashed), resizes to
 * `THUMB_DIMENSION`, and re-encodes as WebP. Returns `null` on any failure
 * (corrupt bytes that passed the content-type check, an unsupported edge
 * case in the codec) — the caller's job is deciding what a failed resize
 * means for the request, not this function's.
 */
export function resizeToSquareThumbnail(bytes: Uint8Array): Uint8Array | null {
  let decoded: PhotonImage | undefined
  let cropped: PhotonImage | undefined
  let resized: PhotonImage | undefined
  try {
    decoded = PhotonImage.new_from_byteslice(bytes)
    const width = decoded.get_width()
    const height = decoded.get_height()
    if (width === 0 || height === 0) return null

    const side = Math.min(width, height)
    const x1 = Math.floor((width - side) / 2)
    const y1 = Math.floor((height - side) / 2)
    // Always a distinct object from `decoded`, even when the crop rectangle
    // is the full image — never skip this to "optimise" the square case,
    // or `decoded` and `cropped` alias the same wasm-linear-memory object
    // and the `finally` block below double-frees it.
    cropped = crop(decoded, x1, y1, x1 + side, y1 + side)

    resized = photonResize(cropped, THUMB_DIMENSION, THUMB_DIMENSION, SamplingFilter.Lanczos3)
    return resized.get_bytes_webp()
  } catch {
    return null
  } finally {
    // Wasm-linear-memory objects, not GC'd JS ones — an upload endpoint that
    // skipped this would leak isolate memory on every request.
    decoded?.free()
    cropped?.free()
    resized?.free()
  }
}
