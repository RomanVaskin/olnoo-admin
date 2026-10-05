// Signed Test Session token (Test Traffic v1). PORTABLE: only `node:crypto`, no Next.js, no DB, no `@/` aliases, no env
// access — the DriveSet repo (PR C) copies this file verbatim, so both sides verify exactly the same token.
//
// FORMAT (spec, version 1)
//   token     = "olnoo-t1" "." payloadB64 "." signatureB64
//   payloadB64   = base64url(UTF-8 JSON), no padding, of EXACTLY these fields (no others):
//                  { "v": 1, "p": "<project slug>", "iat": <unix s>, "exp": <unix s>, "sid": "<base64url, >=16 random bytes>", "k": <key version> }
//   signature    = HMAC-SHA256(secret[k], "olnoo-t1." + payloadB64), base64url, no padding (32 bytes)
// The token carries no secret and no personal data. It is a bearer capability valid until `exp` for ONE project.
// Verification order: structure → v → k known → secret configured → project → signature (constant time) → expiry.
// Nothing here ever throws for an ordinary bad token and no error text contains the token or a secret.

import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

export const TOKEN_PREFIX = 'olnoo-t1'
export const TOKEN_VERSION = 1
export const MIN_SECRET_LENGTH = 32
export const MIN_SID_BYTES = 16
export const MAX_TTL_SECONDS = 12 * 60 * 60

const B64URL_RE = /^[A-Za-z0-9_-]+$/
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const PAYLOAD_KEYS = ['v', 'p', 'iat', 'exp', 'sid', 'k']

export type TestSessionPayload = { v: number; p: string; iat: number; exp: number; sid: string; k: number }

/** Secrets by key version. A version that is absent from the object is unsupported; present but empty = not configured. */
export type SecretsByVersion = Readonly<Record<number, string | undefined>>

const b64url = (buf: Buffer) => buf.toString('base64url')
const sign = (secret: string, payloadB64: string) => createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${payloadB64}`).digest()
const usableSecret = (secret: unknown): secret is string => typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH

// ---------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------

export type IssueResult =
  | { ok: true; token: string; payload: TestSessionPayload; issuedAt: Date; expiresAt: Date; sessionId: string }
  | { ok: false; reason: 'secret_not_configured' | 'invalid_ttl' | 'invalid_project' }

export function issueTestSessionToken(input: {
  project: string
  secret: string | undefined
  /** Lifetime in seconds: an integer from 1 to 43 200 (12 h). */
  ttlSeconds: number
  keyVersion?: number
  /** Injected clock (ms since epoch); defaults to Date.now(). */
  now?: number
  /** Injected randomness for tests; defaults to crypto.randomBytes. */
  randomBytes?: (size: number) => Buffer
}): IssueResult {
  if (typeof input.project !== 'string' || !SLUG_RE.test(input.project)) return { ok: false, reason: 'invalid_project' }
  if (!usableSecret(input.secret)) return { ok: false, reason: 'secret_not_configured' }
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > MAX_TTL_SECONDS) return { ok: false, reason: 'invalid_ttl' }
  const k = input.keyVersion ?? 1
  if (!Number.isSafeInteger(k) || k < 1) return { ok: false, reason: 'secret_not_configured' }

  const iat = Math.floor((input.now ?? Date.now()) / 1000)
  const sid = b64url((input.randomBytes ?? nodeRandomBytes)(MIN_SID_BYTES))
  const payload: TestSessionPayload = { v: TOKEN_VERSION, p: input.project, iat, exp: iat + input.ttlSeconds, sid, k }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const token = `${TOKEN_PREFIX}.${payloadB64}.${b64url(sign(input.secret, payloadB64))}`
  return { ok: true, token, payload, issuedAt: new Date(iat * 1000), expiresAt: new Date(payload.exp * 1000), sessionId: sid }
}

// ---------------------------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------------------------

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_project' | 'unsupported_version' | 'unsupported_key_version' | 'secret_not_configured'

export type VerifyResult =
  | { valid: true; project: string; issuedAt: Date; expiresAt: Date; sessionId: string; keyVersion: number }
  | { valid: false; reason: VerifyFailure }

const fail = (reason: VerifyFailure): VerifyResult => ({ valid: false, reason })

/** Strict structural parse of the payload: exactly the six fields, correct types, exp > iat. */
function parsePayload(payloadB64: string): TestSessionPayload | null {
  if (!B64URL_RE.test(payloadB64)) return null
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((k) => keys.includes(k))) return null
  const { v, p, iat, exp, sid, k } = o
  if (!Number.isSafeInteger(v) || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || !Number.isSafeInteger(k)) return null
  if (typeof p !== 'string' || !SLUG_RE.test(p)) return null
  if (typeof sid !== 'string' || !B64URL_RE.test(sid) || Buffer.from(sid, 'base64url').length < MIN_SID_BYTES) return null
  if ((exp as number) <= (iat as number) || (k as number) < 1) return null
  return { v: v as number, p, iat: iat as number, exp: exp as number, sid, k: k as number }
}

export function verifyTestSessionToken(
  token: unknown,
  opts: { project: string; secrets: SecretsByVersion; /** Injected clock (ms since epoch). */ now?: number },
): VerifyResult {
  if (typeof token !== 'string' || token.length > 2048) return fail('malformed')
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return fail('malformed')
  const [, payloadB64, signatureB64] = parts
  const payload = parsePayload(payloadB64)
  if (!payload || !B64URL_RE.test(signatureB64)) return fail('malformed')

  if (payload.v !== TOKEN_VERSION) return fail('unsupported_version')
  if (!Object.prototype.hasOwnProperty.call(opts.secrets, payload.k)) return fail('unsupported_key_version')
  const secret = opts.secrets[payload.k]
  if (!usableSecret(secret)) return fail('secret_not_configured')
  if (payload.p !== opts.project) return fail('wrong_project')

  const given = Buffer.from(signatureB64, 'base64url')
  const expected = sign(secret, payloadB64)
  // Constant-time comparison of equal-length buffers (an HMAC-SHA256 is always 32 bytes).
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail('bad_signature')

  if ((opts.now ?? Date.now()) >= payload.exp * 1000) return fail('expired')
  return { valid: true, project: payload.p, issuedAt: new Date(payload.iat * 1000), expiresAt: new Date(payload.exp * 1000), sessionId: payload.sid, keyVersion: payload.k }
}
