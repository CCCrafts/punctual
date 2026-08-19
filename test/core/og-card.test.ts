/**
 * The pure parts of the dynamic OG card (CCC-496) — checkable without satori
 * or resvg-wasm, so the fallback threshold and card content stay fast to
 * verify. The actual rendered-PNG path is covered under test/workers/og.test.ts,
 * which needs the real wasm runtime.
 */

import { describe, expect, it } from 'vitest'
import { isRenderSafe } from '../../src/http/og/safety.js'
import { buildOgCard } from '../../src/http/og/card.js'

describe('isRenderSafe', () => {
  it('accepts ordinary printable-ASCII labels', () => {
    expect(isRenderSafe('Book 30 min', 'with Serge', '10:30 GMT+3')).toBe(true)
  })

  it('rejects emoji', () => {
    expect(isRenderSafe('Book 30 min', 'with 👋 Serge')).toBe(false)
  })

  it('rejects non-Latin scripts', () => {
    expect(isRenderSafe('Book 30 min', 'with Сергей')).toBe(false)
    expect(isRenderSafe('Book 30 min', 'with 田中')).toBe(false)
  })

  it('rejects an empty label', () => {
    expect(isRenderSafe('')).toBe(false)
  })

  it('rejects a label past the length cap', () => {
    expect(isRenderSafe('with ' + 'x'.repeat(40))).toBe(false)
  })
})

describe('buildOgCard', () => {
  it('places the formatted title, subtitle and time label into the tree', () => {
    const tree = buildOgCard({
      titleLine: 'Book 30 min',
      subtitleLine: 'with Serge',
      timeLabel: '10:30 GMT+3',
      brandName: 'Punctual',
    })
    const serialised = JSON.stringify(tree)
    expect(serialised).toContain('Book 30 min')
    expect(serialised).toContain('with Serge')
    expect(serialised).toContain('10:30 GMT+3')
    // Lowercased, colon-mark wordmark (docs/branding/brand.md §1) — never the title-cased brand name.
    expect(serialised).toContain('punctual')
    expect(serialised).not.toContain('Punctual')
  })
})
