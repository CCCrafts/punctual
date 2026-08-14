import { describe, expect, it } from 'vitest'
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
    const flipped = ciphertext.slice(0, -1) + (ciphertext.endsWith('A') ? 'B' : 'A')
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
    const tampered = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')
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
