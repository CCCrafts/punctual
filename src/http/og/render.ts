/**
 * Renders a booking page's dynamic OG card to PNG bytes (CCC-496), or
 * returns `null` if it should not be attempted — the caller (route.ts) then
 * falls back to the static `assets/og/default.png`, which is always correct
 * even if generic. A broken card is worse than a generic one, so every
 * failure mode here is a `null`, never a thrown error reaching the route.
 *
 * satori (HTML/CSS-like tree → SVG, text as vector paths) + resvg-wasm
 * (SVG → PNG) is the standard combo for this on Workers. Both need their
 * wasm loaded manually — Workers restricts dynamic wasm fetch/instantiate,
 * so `satori/standalone` + a wrangler-bundled `.wasm` import (a
 * `WebAssembly.Module`, handed straight to `init`/`initWasm`) is required
 * instead of the Node-style "fetch the wasm over HTTP" init path.
 */

import satori, { init as initSatori } from 'satori/standalone'
// Bundled by wrangler/esbuild as a WebAssembly.Module — the same mechanism
// already used for `yoga.wasm` here, just from a different package.
// @ts-expect-error - no type declaration for a .wasm import
import yogaWasm from '../../../node_modules/satori/yoga.wasm'
import { Resvg, initWasm } from '@resvg/resvg-wasm'
// @ts-expect-error - no type declaration for a .wasm import
import resvgWasmModule from '../../../node_modules/@resvg/resvg-wasm/index_bg.wasm'

import { buildOgCard } from './card.js'
import { plexMonoSubset, schibstedGroteskSubset } from './fonts.js'
import { isRenderSafe } from './safety.js'

export interface OgRenderInput {
  hostName: string
  brandName: string
  durationMinutes: number
  /** Already formatted for display, e.g. "10:30 GMT+3" — render.ts has no timezone policy of its own. */
  timeLabel: string
}

const WIDTH = 1200
const HEIGHT = 630

// Module-scope: an isolate renders many requests, and both wasm modules only
// need instantiating once per isolate. The promise (not a boolean) is what
// makes concurrent first-requests await the same init instead of racing it.
let ready: Promise<void> | undefined
function ensureInit(): Promise<void> {
  return (ready ??= (async () => {
    await initSatori(yogaWasm)
    await initWasm(resvgWasmModule)
  })())
}

export async function renderOgCard(input: OgRenderInput): Promise<Uint8Array | null> {
  const titleLine = `Book ${input.durationMinutes} min`
  const subtitleLine = `with ${input.hostName}`
  if (!isRenderSafe(titleLine, subtitleLine, input.timeLabel, input.brandName)) return null

  try {
    await ensureInit()

    const element = buildOgCard({ titleLine, subtitleLine, timeLabel: input.timeLabel, brandName: input.brandName })
    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: WIDTH,
      height: HEIGHT,
      fonts: [
        { name: 'IBM Plex Mono', data: plexMonoSubset().buffer as ArrayBuffer, weight: 600, style: 'normal' },
        {
          name: 'Schibsted Grotesk',
          data: schibstedGroteskSubset().buffer as ArrayBuffer,
          weight: 600,
          style: 'normal',
        },
      ],
    })

    // satori already vectorised every glyph into SVG paths (its default
    // `embedFont: true`), so resvg has no live text to shape — no fonts to
    // give it, and system-font lookup is both unavailable under workerd and
    // unnecessary here.
    const resvg = new Resvg(svg, { font: { loadSystemFonts: false } })
    const rendered = resvg.render()
    const png = rendered.asPng()
    rendered.free()
    resvg.free()
    return png
  } catch {
    return null
  }
}
