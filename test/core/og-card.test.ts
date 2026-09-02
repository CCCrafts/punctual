/**
 * The pure parts of the dynamic OG card — checkable without satori
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

describe('buildOgCard with faces', () => {
  it('one host: a single large face, a photo when there is one', () => {
    const tree = JSON.stringify(
      buildOgCard({ titleLine: 'Book 30 min', subtitleLine: 'with Serge', timeLabel: '10:30 GMT+3', brandName: 'Punctual', avatars: [{ src: 'data:image/png;base64,AAAA', initial: 'S' }] }),
    )
    expect(tree).toContain('"type":"img"')
    expect(tree).toContain('data:image/png;base64,AAAA')
    expect(tree).toContain('"width":220')
  })

  it('a team: up to three faces as initials when unphotographed, then a "+N" disc', () => {
    const tree = JSON.stringify(
      buildOgCard({
        titleLine: 'Book 30 min',
        subtitleLine: 'with the OG Crew team',
        timeLabel: '10:30 GMT+3',
        brandName: 'Punctual',
        avatars: [{ initial: 'A' }, { initial: 'B' }, { initial: 'C' }],
        extraCount: 2,
      }),
    )
    expect(tree).not.toContain('"type":"img"')
    expect(tree).toContain('"children":"A"')
    expect(tree).toContain('"children":"C"')
    expect(tree).toContain('"children":"+2"')
    expect(tree).toContain('"width":"132px"')
  })

  it('no avatars: the text-only card, unchanged', () => {
    const tree = JSON.stringify(buildOgCard({ titleLine: 'Book 30 min', subtitleLine: 'with Serge', timeLabel: '10:30 GMT+3', brandName: 'Punctual' }))
    expect(tree).not.toContain('"type":"img"')
    expect(tree).not.toContain('132px')
  })
})
