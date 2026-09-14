import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'

/**
 * The adapter touches no Cloudflare binding — WebCrypto is a global in Workers
 * and in Node 20+ alike — so it is exercised here, in the fast `core` project,
 * rather than under the Workers pool.
 */

/** Deterministic 32-byte key material, base64, so failures are reproducible. */
function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

const KEY_V1 = keyMaterial(1)
const KEY_V2 = keyMaterial(2)
const SIGNING = keyMaterial(9)

function subject(keys: Record<number, string>, currentVersion: number) {
  return createWebCrypto({ keys, currentVersion, signingKey: SIGNING })
}

const AAD = 'user_1|google|conn_1'

describe('encrypt / decrypt', () => {
  it('round-trips a token', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const { ciphertext, keyVersion } = await c.encrypt('refresh-token-abc', AAD)
    expect(keyVersion).toBe(1)
    expect(await c.decrypt(ciphertext, AAD, 1)).toBe('refresh-token-abc')
  })

  it('round-trips non-ASCII plaintext', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const secret = 'токен—✓'
    const { ciphertext } = await c.encrypt(secret, AAD)
    expect(await c.decrypt(ciphertext, AAD, 1)).toBe(secret)
  })

  it('FAILS to decrypt under a different AAD — a ciphertext moved between rows is dead (ADR-0005 §6)', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const { ciphertext } = await c.encrypt('refresh-token-abc', AAD)
    // Same key, same ciphertext, different connection id: authentication fails.
    await expect(c.decrypt(ciphertext, 'user_2|google|conn_1', 1)).rejects.toThrow()
    await expect(c.decrypt(ciphertext, 'user_1|microsoft|conn_1', 1)).rejects.toThrow()
    await expect(c.decrypt(ciphertext, '', 1)).rejects.toThrow()
  })

  it('rejects a tampered ciphertext', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const { ciphertext } = await c.encrypt('refresh-token-abc', AAD)
    // Flip the FIRST character, not the last: base64url's final character
    // carries spare bits, so a tail flip can decode to identical bytes and
    // the assertion would pass or fail on the luck of the key material.
    const flipped = (ciphertext.startsWith('A') ? 'B' : 'A') + ciphertext.slice(1)
    await expect(c.decrypt(flipped, AAD, 1)).rejects.toThrow()
  })

  it('never reuses an IV: the same plaintext encrypts differently every time', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const seen = new Set<string>()
    for (let i = 0; i < 25; i++) {
      const { ciphertext } = await c.encrypt('identical', AAD)
      // The IV is the leading 12 bytes = 16 base64url chars.
      seen.add(ciphertext.slice(0, 16))
    }
    expect(seen.size).toBe(25)
  })

  it('refuses to construct without material for the current version', () => {
    expect(() => subject({ 1: KEY_V1 }, 2)).toThrow()
  })

  it('rejects an unknown key version rather than returning garbage', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const { ciphertext } = await c.encrypt('x', AAD)
    await expect(c.decrypt(ciphertext, AAD, 7)).rejects.toThrow(/unknown key version/)
  })
})

describe('key rotation (ADR-0005 §6)', () => {
  it('encrypts with the new version while old ciphertext stays readable', async () => {
    const before = subject({ 1: KEY_V1 }, 1)
    const old = await before.encrypt('legacy-refresh-token', AAD)
    expect(old.keyVersion).toBe(1)

    // The rotation: both keys present, new writes go to v2.
    const after = subject({ 1: KEY_V1, 2: KEY_V2 }, 2)
    expect(await after.decrypt(old.ciphertext, AAD, old.keyVersion)).toBe('legacy-refresh-token')

    const fresh = await after.encrypt('new-refresh-token', AAD)
    expect(fresh.keyVersion).toBe(2)
    expect(await after.decrypt(fresh.ciphertext, AAD, 2)).toBe('new-refresh-token')
  })

  it('a v2 ciphertext is not readable with the v1 key', async () => {
    const after = subject({ 1: KEY_V1, 2: KEY_V2 }, 2)
    const { ciphertext } = await after.encrypt('new-refresh-token', AAD)
    await expect(after.decrypt(ciphertext, AAD, 1)).rejects.toThrow()
  })
})

describe('sign / verify', () => {
  it('round-trips a manage-link payload', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const payload = 'bk_123|cancel|1789000000000'
    const sig = await c.sign(payload)
    expect(await c.verify(payload, sig)).toBe(true)
  })

  it('is deterministic for the same payload', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    expect(await c.sign('bk_123|cancel|1')).toBe(await c.sign('bk_123|cancel|1'))
  })

  it('rejects a tampered signature', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const payload = 'bk_123|cancel|1789000000000'
    const sig = await c.sign(payload)
    // First character, for the same reason as above.
    const tampered = (sig.startsWith('A') ? 'B' : 'A') + sig.slice(1)
    expect(await c.verify(payload, tampered)).toBe(false)
    expect(await c.verify(payload, '')).toBe(false)
    expect(await c.verify(payload, 'not-base64!!')).toBe(false)
  })

  it('rejects a signature bound to a different purpose (ADR-0005 §4)', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const cancel = await c.sign('bk_123|cancel|1789000000000')
    expect(await c.verify('bk_123|reschedule|1789000000000', cancel)).toBe(false)
  })

  it('rejects a signature made with a different key', async () => {
    const a = createWebCrypto({ keys: { 1: KEY_V1 }, currentVersion: 1, signingKey: KEY_V1 })
    const b = createWebCrypto({ keys: { 1: KEY_V1 }, currentVersion: 1, signingKey: KEY_V2 })
    const sig = await a.sign('bk_123|cancel|1')
    expect(await b.verify('bk_123|cancel|1', sig)).toBe(false)
  })
})

describe('construction fails closed on missing key material', () => {
  it('throws when the current encryption key version is missing', () => {
    expect(() => createWebCrypto({ keys: {}, currentVersion: 1, signingKey: SIGNING })).toThrow(
      /no key material/,
    )
  })

  it('throws when SIGNING_KEY is an empty string', () => {
    // Not merely undefined: `env.SIGNING_KEY ?? ''` is exactly what a missing
    // Workers secret produces, and an empty string base64-decodes to a
    // zero-length key that WebCrypto would otherwise import without
    // complaint — silently signing every manage link and OAuth state with a
    // fixed, publicly computable HMAC key instead of refusing to start.
    expect(() => createWebCrypto({ keys: { 1: KEY_V1 }, currentVersion: 1, signingKey: '' })).toThrow(
      /SIGNING_KEY/,
    )
  })
})

describe('randomToken / hash', () => {
  it('produces 256-bit url-safe tokens by default (ADR-0005 §2)', () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const token = c.randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBe(43) // 32 bytes, base64url, unpadded
    expect(c.randomToken(16).length).toBe(22)
  })

  it('does not repeat', () => {
    const c = subject({ 1: KEY_V1 }, 1)
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(c.randomToken())
    expect(seen.size).toBe(500)
  })

  it('hashes to lowercase SHA-256 hex, stable across instances', async () => {
    const c = subject({ 1: KEY_V1 }, 1)
    expect(await c.hash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(await c.hash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    // Session lookup depends on the hash being independent of key material.
    expect(await subject({ 1: KEY_V2 }, 1).hash('abc')).toBe(await c.hash('abc'))
  })
})

// ===========================================================================
// Email senders
// ===========================================================================

describe('Brevo sender', () => {
  async function capture(message: Parameters<import('../../src/ports.js').EmailSender['send']>[0]) {
    const { createBrevoSender } = await import('../../src/adapters/email/index.js')
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null
    const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')),
      }
      return new Response('{}', { status: 201 })
    }) as typeof globalThis.fetch

    const sender = createBrevoSender({
      apiKey: 'xkeysib-test',
      from: 'hello@punctual.sh',
      fromName: 'Punctual',
      fetch: fake,
    })
    await sender.send(message)
    return seen!
  }

  it('authenticates with api-key, not Authorization', async () => {
    const seen = await capture({ to: 'g@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    // Brevo differs from Resend here, and getting it wrong is a silent 401.
    expect(seen.headers['api-key']).toBe('xkeysib-test')
    expect(seen.headers['Authorization']).toBeUndefined()
  })

  it('maps the message onto Brevo field names', async () => {
    const seen = await capture({
      to: 'g@example.com',
      toName: 'Guest',
      subject: 'Booked',
      html: '<p>x</p>',
      text: 'x',
    })
    expect(seen.body['sender']).toEqual({ email: 'hello@punctual.sh', name: 'Punctual' })
    expect(seen.body['to']).toEqual([{ email: 'g@example.com', name: 'Guest' }])
    expect(seen.body['htmlContent']).toBe('<p>x</p>')
    expect(seen.body['textContent']).toBe('x')
  })

  it('uses {name, content} for attachments, not {filename, content}', async () => {
    // Every booking email carries an .ics, so this field name decides whether
    // the calendar invitation arrives at all.
    const seen = await capture({
      to: 'g@example.com',
      subject: 'Booked',
      html: '<p>x</p>',
      text: 'x',
      attachments: [{ filename: 'invite.ics', content: 'BASE64', contentType: 'text/calendar' }],
    })
    expect(seen.body['attachment']).toEqual([{ name: 'invite.ics', content: 'BASE64' }])
  })

  it('surfaces the response body on failure', async () => {
    const { createBrevoSender } = await import('../../src/adapters/email/index.js')
    const failing = (async () =>
      new Response('{"message":"Sender domain not verified"}', { status: 400 })) as typeof globalThis.fetch
    const sender = createBrevoSender({
      apiKey: 'k',
      from: 'x@y.z',
      fromName: 'P',
      fetch: failing,
    })
    // The body names the actual cause — usually an unverified sender domain,
    // which is the most common first-send failure.
    await expect(
      sender.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/Sender domain not verified/)
  })

  it('sanitizes a guest name/email carrying header-injection characters', async () => {
    // guestName and guestEmail come straight off the public, unauthenticated
    // booking form, so a name like `Ada\r\nBcc: victim@evil.com` must not
    // survive into the `sender`/`to`/`replyTo` fields Brevo turns into real
    // SMTP headers.
    const seen = await capture({
      to: 'ada@example.com',
      toName: 'Ada\r\nBcc: victim@evil.com',
      subject: 'Booked',
      html: '<p>x</p>',
      text: 'x',
      replyTo: 'ada@example.com',
    })
    const to = (seen.body['to'] as Array<{ email: string; name?: string }>)[0]!
    expect(to.name).not.toMatch(/[\r\n]/)
    expect(to.name).toBe('Ada Bcc: victim@evil.com')
    expect(seen.body['sender']).toEqual({ email: 'hello@punctual.sh', name: 'Punctual' })
  })
})

describe('Resend sender', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function capture(message: Parameters<import('../../src/ports.js').EmailSender['send']>[0]) {
    const { createResendSender } = await import('../../src/adapters/email/index.js')
    let seen: { headers: Record<string, string>; body: Record<string, unknown> } | null = null
    const fake = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')),
      }
      return new Response('{}', { status: 201 })
    }) as typeof globalThis.fetch
    vi.stubGlobal('fetch', fake)

    const sender = createResendSender({ apiKey: 'test-key', from: 'hello@punctual.sh', fromName: 'Punctual' })
    await sender.send(message)
    return seen!
  }

  it('quotes the display name into `"Name" <addr>`', async () => {
    const seen = await capture({ to: 'g@example.com', toName: 'Guest', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    expect(seen.body['from']).toBe('"Punctual" <hello@punctual.sh>')
    expect(seen.body['to']).toEqual(['"Guest" <g@example.com>'])
  })

  it('strips CR/LF from a guest name before it reaches the From/To header', async () => {
    // The same class of bug `sanitizeHeader` exists for on the subject line
    // (test/core/email-templates.test.ts) applies here: an unauthenticated
    // guest controls `guestName`, and it lands directly in a formatted
    // `"Name" <addr>` string handed to Resend's API.
    const seen = await capture({
      to: 'ada@example.com',
      toName: 'Ada\r\nBcc: victim@evil.com',
      subject: 'Booked',
      html: '<p>x</p>',
      text: 'x',
      replyTo: 'ada@example.com\r\nX-Injected: yes',
    })
    expect(seen.body['to']).toEqual(['"Ada Bcc: victim@evil.com" <ada@example.com>'])
    expect(String(seen.body['reply_to'])).not.toMatch(/[\r\n]/)
  })

  it('drops embedded quotes so they cannot close the quoted name early', async () => {
    const seen = await capture({
      to: 'g@example.com',
      toName: 'Guest" <attacker@evil.com>, "Innocent',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    })
    expect(seen.body['to']).toEqual(['"Guest <attacker@evil.com>, Innocent" <g@example.com>'])
  })
})

describe('Cloudflare Email Service sender', () => {
  type Builder = Parameters<SendEmail['send']>[0]

  async function capture(
    message: Parameters<import('../../src/ports.js').EmailSender['send']>[0],
    // Not a defaulted parameter: `capture(msg, undefined)` would silently take
    // the default and never exercise the no-display-name branch at all.
    fromName: string | null = 'Punctual',
  ) {
    const { createCloudflareSender } = await import('../../src/adapters/email/index.js')
    let seen: Builder | null = null
    const binding = {
      send: async (m: Builder) => {
        seen = m
        return { messageId: 'msg_1' }
      },
    } as unknown as SendEmail
    const sender = createCloudflareSender({ binding, from: 'hello@punctual.sh', ...(fromName === null ? {} : { fromName }) })
    await sender.send(message)
    return seen! as Builder & Record<string, unknown>
  }

  it('sends through the binding, with no API key anywhere', async () => {
    const seen = await capture({ to: 'g@example.com', toName: 'Guest', subject: 'Booked', html: '<p>x</p>', text: 'x' })
    expect(seen.from).toEqual({ email: 'hello@punctual.sh', name: 'Punctual' })
    expect(seen.to).toEqual({ email: 'g@example.com', name: 'Guest' })
    expect(seen.subject).toBe('Booked')
    expect(seen.html).toBe('<p>x</p>')
    expect(seen.text).toBe('x')
  })

  it('sends a bare address when no display name is configured', async () => {
    const seen = await capture({ to: 'g@example.com', subject: 's', html: 'h', text: 't' }, null)
    expect(seen.from).toBe('hello@punctual.sh')
    expect(seen.to).toBe('g@example.com')
  })

  it('uses {content, filename, type, disposition} for attachments', async () => {
    // Same stakes as the Brevo case: every booking email carries the .ics, and
    // `type`/`filename` here are named differently from both other providers.
    // The base64 string crosses untouched — no decode/re-encode round trip.
    const seen = await capture({
      to: 'g@example.com',
      subject: 'Booked',
      html: '<p>x</p>',
      text: 'x',
      attachments: [{ filename: 'invite.ics', content: 'QkVHSU46VkNBTEVOREFS', contentType: 'text/calendar' }],
    })
    expect(seen.attachments).toEqual([
      { content: 'QkVHSU46VkNBTEVOREFS', filename: 'invite.ics', type: 'text/calendar', disposition: 'attachment' },
    ])
  })

  it('omits attachments and replyTo entirely when absent', async () => {
    // `attachments: undefined` is not the same as the key being absent for a
    // builder the platform validates field-by-field.
    const seen = await capture({ to: 'g@example.com', subject: 's', html: 'h', text: 't' })
    expect('attachments' in seen).toBe(false)
    expect('replyTo' in seen).toBe(false)
  })

  it('sanitizes a guest name/email carrying header-injection characters', async () => {
    const seen = await capture({
      to: 'a@b.c\r\nBcc: victim@evil.com',
      toName: 'Ada\r\nX-Evil: 1',
      subject: 's',
      html: 'h',
      text: 't',
      replyTo: 'host@x.y\r\nBcc: victim@evil.com',
    })
    // sanitizeHeader collapses CR/LF to a space rather than dropping the rest
    // of the value, so `victim@evil.com` survives as inert text inside a single
    // mangled address. That is the correct outcome — what must never survive is
    // the line break that would make it a header of its own.
    expect(JSON.stringify(seen)).not.toMatch(/\\r|\\n/)
    expect(seen.to).toEqual({ email: 'a@b.c Bcc: victim@evil.com', name: 'Ada X-Evil: 1' })
    expect(seen.replyTo).toBe('host@x.y Bcc: victim@evil.com')
  })

  it('explains the un-onboarded-domain failure rather than echoing it', async () => {
    // The failure this translation exists for: until the sending domain is
    // onboarded, the binding delivers only to verified destination addresses
    // in the account — so the instance looks healthy and no guest ever hears
    // from it. The operator must not have to go read the platform docs.
    const { createCloudflareSender } = await import('../../src/adapters/email/index.js')
    const binding = {
      send: async () => {
        const e = new Error('recipient is not a verified destination address')
        ;(e as Error & { code: string }).code = 'E_UNVERIFIED_RECIPIENT'
        throw e
      },
    } as unknown as SendEmail
    const sender = createCloudflareSender({ binding, from: 'x@y.z', fromName: 'P' })
    const err = await sender
      .send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' })
      .then(() => null, (e: Error) => e)
    expect(err?.message).toContain('E_UNVERIFIED_RECIPIENT')
    expect(err?.message).toMatch(/onboarded to Email Service/)
  })

  it('still throws on an unrelated failure, so the queue retries', async () => {
    const { createCloudflareSender } = await import('../../src/adapters/email/index.js')
    const binding = { send: async () => { throw new Error('upstream 503') } } as unknown as SendEmail
    const sender = createCloudflareSender({ binding, from: 'x@y.z', fromName: 'P' })
    await expect(sender.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' })).rejects.toThrow(/upstream 503/)
  })
})
