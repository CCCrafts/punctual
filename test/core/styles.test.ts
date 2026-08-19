import { describe, expect, it } from 'vitest'
import { BASE_CSS, LANDING_CSS, pageCss, TOKENS } from '../../src/http/styles.js'

/**
 * These CSS blocks are plain template-string literals — nothing checks them
 * at build time the way TypeScript checks code. Writing two token names
 * separated by a slash inside a prose comment (e.g. "ink dash star, then a
 * slash, then green dash star") can accidentally spell the comment's own
 * closing delimiter, closing it early and silently corrupting every
 * declaration until the next accidental close, with no error anywhere in the
 * toolchain — this caught a real instance of exactly that bug.
 * `unbalancedComment` is a standalone scanner, not the actual CSS parser,
 * but a stray early close is the one failure mode worth guarding here.
 */
function unbalancedComment(css: string): boolean {
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith('/*', i)) {
      depth++
      i++
    } else if (css.startsWith('*/', i)) {
      if (depth === 0) return true
      depth--
      i++
    }
  }
  return depth !== 0
}

describe('the generated CSS blocks', () => {
  it('never contain a stray or unbalanced /* */ comment marker', () => {
    for (const [name, css] of [
      ['TOKENS', TOKENS],
      ['BASE_CSS', BASE_CSS],
      ['LANDING_CSS', LANDING_CSS],
      ['pageCss()', pageCss()],
    ] as const) {
      expect({ name, unbalanced: unbalancedComment(css) }).toEqual({ name, unbalanced: false })
    }
  })
})
