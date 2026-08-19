import { describe, expect, it } from 'vitest'
import { RESERVED_SLUGS, suggestSlug, validateSlug } from '../../src/core/domain/slugs.js'

describe('validateSlug', () => {
  it('accepts ordinary slugs', () => {
    for (const s of ['serge', 'serge-bulaev', 'a1', 'team-2026']) {
      expect({ s, ...validateSlug(s) }).toEqual({ s, ok: true })
    }
  })

  it('refuses reserved words that would shadow system routes', () => {
    for (const s of ['api', 'login', 'dashboard', 'health', 'mcp', 'booking']) {
      expect(validateSlug(s).reason).toBe('reserved')
    }
  })

  it('refuses anything with a dot, which would read as a filename', () => {
    expect(validateSlug('foo.bar').ok).toBe(false)
    expect(validateSlug('embed.js').ok).toBe(false)
  })

  it('refuses leading and trailing hyphens', () => {
    expect(validateSlug('-serge').reason).toBe('invalid_characters')
    expect(validateSlug('serge-').reason).toBe('invalid_characters')
    expect(validateSlug('a--b').ok).toBe(false)
  })

  it('refuses uppercase and spaces — slugs get typed from memory', () => {
    expect(validateSlug('Serge').ok).toBe(true) // lowercased first
    expect(validateSlug('serge bulaev').reason).toBe('invalid_characters')
  })

  it('enforces length bounds', () => {
    expect(validateSlug('a').reason).toBe('too_short')
    expect(validateSlug('a'.repeat(41)).reason).toBe('too_long')
    expect(validateSlug('a'.repeat(40)).ok).toBe(true)
  })

  it('reserves every route the router actually mounts', () => {
    // If a route is added without reserving its segment, a host could claim it.
    for (const mounted of ['api', 'health', 'mcp', 'embed.js', 'favicon.svg', 'auth', 'booking', 'og']) {
      expect({ mounted, reserved: RESERVED_SLUGS.has(mounted) }).toEqual({ mounted, reserved: true })
    }
  })
})

describe('suggestSlug', () => {
  it('derives from an email local part', () => {
    expect(suggestSlug('serge@example.com')).toBe('serge')
  })

  it('strips diacritics rather than dropping the characters', () => {
    expect(suggestSlug('José Álvarez')).toBe('jose-alvarez')
  })

  it('collapses punctuation and trims hyphens', () => {
    expect(suggestSlug('  Serge   Bulaev!! ')).toBe('serge-bulaev')
  })

  it('falls back rather than returning something unusable', () => {
    expect(suggestSlug('!!!')).toBe('user')
    expect(suggestSlug('')).toBe('user')
  })

  it('never suggests something longer than the limit', () => {
    expect(suggestSlug('a'.repeat(100)).length).toBeLessThanOrEqual(40)
  })
})
