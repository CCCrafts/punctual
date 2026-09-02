/**
 * The render-safety check for the dynamic OG card, split out from
 * render.ts so it stays importable from test/core (plain Node) without
 * dragging in satori/resvg-wasm's module-scope `.wasm` imports, which only
 * resolve under the real Workers runtime (test/workers, or wrangler/esbuild).
 */

/**
 * Printable ASCII only (U+0020–007E) — exactly the range `fonts.ts` subsets
 * to. Anything outside it (emoji, RTL scripts, CJK, accented Latin) is safer
 * left to the static default card than risked against a font that cannot
 * render it: satori does not error on a missing glyph, it silently drops it,
 * so a bad render would look broken rather than fail loudly.
 */
const ASCII_SAFE = /^[\x20-\x7E]*$/

/** Long enough to look wrong on a 1200x630 card well before satori's layout would actually overflow. */
const MAX_LABEL_LENGTH = 40

export function isRenderSafe(...labels: string[]): boolean {
  return labels.every((s) => s.length > 0 && s.length <= MAX_LABEL_LENGTH && ASCII_SAFE.test(s))
}
