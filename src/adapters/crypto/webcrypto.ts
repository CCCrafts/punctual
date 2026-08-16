/**
 * The `Crypto` port over WebCrypto (ADR-0005 §4, §6).
 *
 * WebCrypto is a global in Workers and in Node 20+, so this adapter has no
 * imports and runs unchanged in both — which is why its tests live in the
 * plain-Node `core` project rather than needing the Workers pool.
 *
 * Two independent key materials live here on purpose:
 *  - `keys` encrypt calendar refresh tokens at rest. Versioned, because
 *    rotation is decrypt-with-old / encrypt-with-new (ADR-0005 §6) and the
 *    `key_version` column exists from day one to make that possible.
 *  - `signingKey` signs guest manage links. Not versioned: those tokens are
 *    short-lived relative to a key rotation, and rotating the signing key is
 *    meant to invalidate outstanding links rather than preserve them.
 */

import type { Crypto as CryptoPort } from '../../ports.js'

export interface WebCryptoOptions {
  /** version → base64 (standard or url-safe) 256-bit key material. */
  keys: Record<number, string>
  /** The version new ciphertext is written with. Old versions stay decryptable. */
  currentVersion: number
  /** base64 HMAC-SHA256 key for signed links (ADR-0005 §4). */
  signingKey: string
}

/** AES-GCM's nominal IV size. 96 bits is the only length with no extra derivation step. */
const IV_BYTES = 12

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createWebCrypto(opts: WebCryptoOptions): CryptoPort {
  const current = opts.currentVersion
  if (opts.keys[current] === undefined) {
    throw new Error(`crypto: no key material for currentVersion ${current}`)
  }
  // Same failure mode as a missing encryption key, and the same fix: an empty
  // string base64-decodes to a zero-length key that WebCrypto imports without
  // complaint, so a missing SIGNING_KEY would otherwise sign and verify every
  // guest manage link and OAuth state with a fixed, publicly computable HMAC
  // key instead of refusing to start.
  if (!opts.signingKey) {
    throw new Error('crypto: SIGNING_KEY is required')
  }

  // Key import is async and not free; cache the promise so N concurrent
  // decrypts in one request import once rather than N times.
  const aesKeys = new Map<number, Promise<CryptoKey>>()
  let hmacKey: Promise<CryptoKey> | null = null

  function aesKey(version: number): Promise<CryptoKey> {
    const cached = aesKeys.get(version)
    if (cached) return cached
    const material = opts.keys[version]
    if (material === undefined) {
      // Rejecting loudly beats returning garbage: an unknown version means the
      // operator dropped a key that rows still reference.
      return Promise.reject(new Error(`crypto: unknown key version ${version}`))
    }
    const imported = crypto.subtle.importKey('raw', decodeBase64(material), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ])
    aesKeys.set(version, imported)
    return imported
  }

  function signingCryptoKey(): Promise<CryptoKey> {
    if (!hmacKey) {
      hmacKey = crypto.subtle.importKey(
        'raw',
        decodeBase64(opts.signingKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      )
    }
    return hmacKey
  }

  return {
    async encrypt(plaintext, aad) {
      // A fresh random IV per record, never reused: AES-GCM leaks plaintext
      // XOR and, worse, the authentication key under IV reuse (ADR-0005 §6).
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
      const key = await aesKey(current)
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
        key,
        encoder.encode(plaintext),
      )
      // iv || ciphertext||tag. The IV is not secret, only unique, so storing it
      // beside the ciphertext is what keeps the record self-contained.
      const out = new Uint8Array(IV_BYTES + sealed.byteLength)
      out.set(iv, 0)
      out.set(new Uint8Array(sealed), IV_BYTES)
      return { ciphertext: encodeBase64Url(out), keyVersion: current }
    },

    async decrypt(ciphertext, aad, keyVersion) {
      const raw = decodeBase64(ciphertext)
      if (raw.length <= IV_BYTES) throw new Error('crypto: ciphertext too short')
      const key = await aesKey(keyVersion)
      // AAD binds user_id|provider|connection_id, so a ciphertext moved to
      // another row fails authentication here rather than decrypting into the
      // wrong account's tokens (ADR-0005 §6).
      const opened = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: raw.subarray(0, IV_BYTES), additionalData: encoder.encode(aad) },
        key,
        raw.subarray(IV_BYTES),
      )
      return decoder.decode(opened)
    },

    async sign(payload) {
      const key = await signingCryptoKey()
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
      return encodeBase64Url(new Uint8Array(sig))
    },

    async verify(payload, signature) {
      let sig: Uint8Array
      try {
        sig = decodeBase64(signature)
      } catch {
        // Malformed input is a failed verification, not a 500.
        return false
      }
      const key = await signingCryptoKey()
      // crypto.subtle.verify compares in constant time. Re-signing and
      // comparing strings would leak the correct prefix length by timing.
      return crypto.subtle.verify('HMAC', key, sig, encoder.encode(payload))
    },

    randomToken(bytes = 32) {
      return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
    },

    async hash(value) {
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
      return toHex(new Uint8Array(digest))
    },
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** base64url, unpadded — safe in URLs, cookies and JSON alike. */
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Accepts standard and url-safe base64, padded or not — key material comes from
 * Workers Secrets typed by a human, and rejecting a `+` there would be a
 * confusing outage rather than a security property.
 */
function decodeBase64(value: string): Uint8Array {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
  return out
}
