/**
 * Slug rules.
 *
 * A user's slug is the first path segment of their booking page
 * (`/{slug}/{event}`), so it shares a namespace with every system route. A
 * host who claimed `api` or `login` would either shadow those routes or find
 * their own page unreachable, depending on mount order — confusing either way,
 * and worth refusing at the point of choice rather than debugging later.
 */

/**
 * Reserved first path segments.
 *
 * Includes routes that exist today, obvious near-misses, and words we are
 * likely to want later. Taking a name back from a user who is already sharing
 * their link is far more painful than refusing it up front, so this list errs
 * toward reserving too much.
 */
export const RESERVED_SLUGS = new Set([
  // Live routes
  'api', 'health', 'mcp', 'embed', 'embed.js', 'favicon.svg', 'robots.txt',
  'auth', 'login', 'logout', 'dashboard', 'booking', 'bookings',
  // Near-misses and likely future routes
  'admin', 'settings', 'account', 'billing', 'pricing', 'signup', 'signin',
  'register', 'app', 'www', 'static', 'assets', 'public', 'docs', 'help',
  'support', 'status', 'blog', 'about', 'terms', 'privacy', 'legal',
  // Infrastructure hostnames under punctual.sh (ADR-0008).
  'mail', 'smtp', 'mx', 'ns', 'cdn',
  'security', 'webhooks', 'oauth', 'callback', 'verify', 'reset',
  'team', 'teams', 'user', 'users', 'me', 'new', 'edit', 'delete',
  '.well-known', 'null', 'undefined',
])

export interface SlugValidation {
  ok: boolean
  reason?: 'too_short' | 'too_long' | 'invalid_characters' | 'reserved' | 'looks_like_a_file'
  message?: string
}

/**
 * Validate a proposed slug.
 *
 * Lowercase alphanumerics and hyphens only: slugs appear in URLs people read
 * aloud and type from memory, and mixed case makes "is that a capital I or a
 * lowercase l" a support ticket.
 */
export function validateSlug(raw: string): SlugValidation {
  const slug = raw.trim().toLowerCase()

  if (slug.length < 2) {
    return { ok: false, reason: 'too_short', message: 'Must be at least 2 characters' }
  }
  if (slug.length > 40) {
    return { ok: false, reason: 'too_long', message: 'Must be 40 characters or fewer' }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return {
      ok: false,
      reason: 'invalid_characters',
      message: 'Use lowercase letters, numbers and hyphens (not at the start or end)',
    }
  }
  // A slug containing a dot would collide with static-asset routing and, worse,
  // could be mistaken for a filename in a link.
  if (slug.includes('.')) {
    return { ok: false, reason: 'looks_like_a_file', message: 'Cannot contain a dot' }
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, reason: 'reserved', message: 'That name is reserved' }
  }
  return { ok: true }
}

/**
 * Best-effort slug from a name or email, for suggesting a default.
 * The caller must still run `validateSlug` and handle collisions.
 */
export function suggestSlug(nameOrEmail: string): string {
  const base = nameOrEmail.split('@')[0] ?? nameOrEmail
  const slug = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics: José → jose
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug.length >= 2 ? slug : 'user'
}
