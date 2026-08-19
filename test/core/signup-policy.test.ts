/**
 * The signup policy — who may CREATE an account. Parsing (the SIGNUPS env
 * var's three shapes) and matching (exact email, @domain suffix, case and
 * whitespace tolerance). The end-to-end gates live in
 * test/workers/dashboard.test.ts against the real routes.
 */

import { describe, expect, it } from 'vitest'
import { parseSignupPolicy, signupAllowed } from '../../src/core/domain/auth-flows.js'

describe('parseSignupPolicy', () => {
  it('unset, empty and "open" all mean open', () => {
    expect(parseSignupPolicy(undefined)).toEqual({ mode: 'open' })
    expect(parseSignupPolicy('')).toEqual({ mode: 'open' })
    expect(parseSignupPolicy('  ')).toEqual({ mode: 'open' })
    expect(parseSignupPolicy('open')).toEqual({ mode: 'open' })
    expect(parseSignupPolicy('OPEN')).toEqual({ mode: 'open' })
  })

  it('"closed" means closed, case-insensitively', () => {
    expect(parseSignupPolicy('closed')).toEqual({ mode: 'closed' })
    expect(parseSignupPolicy(' Closed ')).toEqual({ mode: 'closed' })
  })

  it('anything else parses as an allowlist, lowercased and trimmed', () => {
    expect(parseSignupPolicy('Serge@Acme.com, @CCCrafts.ai')).toEqual({
      mode: 'allowlist',
      entries: ['serge@acme.com', '@cccrafts.ai'],
    })
  })

  it('a list that trims to nothing falls back to open, never a lockout', () => {
    expect(parseSignupPolicy(', ,')).toEqual({ mode: 'open' })
  })
})

describe('signupAllowed', () => {
  const allow = parseSignupPolicy('serge@acme.com, @cccrafts.ai')

  it('open (or no policy) allows anyone', () => {
    expect(signupAllowed('anyone@anywhere.com', undefined)).toBe(true)
    expect(signupAllowed('anyone@anywhere.com', { mode: 'open' })).toBe(true)
  })

  it('closed allows nobody', () => {
    expect(signupAllowed('serge@acme.com', { mode: 'closed' })).toBe(false)
  })

  it('matches an exact email, case-insensitively', () => {
    expect(signupAllowed('Serge@ACME.com', allow)).toBe(true)
    expect(signupAllowed('other@acme.com', allow)).toBe(false)
  })

  it('matches a whole domain via the @ prefix', () => {
    expect(signupAllowed('newhire@cccrafts.ai', allow)).toBe(true)
    expect(signupAllowed('newhire@notcccrafts.ai', allow)).toBe(false)
  })

  it('a domain entry never matches a lookalike suffix', () => {
    // "@cccrafts.ai" must not admit "x@evilcccrafts.ai" — the match is on the
    // full domain from the last @, not a substring.
    expect(signupAllowed('x@evilcccrafts.ai', allow)).toBe(false)
  })
})
