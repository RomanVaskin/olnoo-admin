import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { issueTestSessionToken, MAX_TTL_SECONDS, TOKEN_PREFIX, verifyTestSessionToken, type SecretsByVersion } from './test-session-token.ts'

const SECRET = 'a'.repeat(64)
const OTHER_SECRET = 'b'.repeat(64)
const NOW = Date.parse('2026-10-05T12:00:00Z')
const secrets: SecretsByVersion = { 1: SECRET }
const issue = (over: Partial<Parameters<typeof issueTestSessionToken>[0]> = {}) => {
  const r = issueTestSessionToken({ project: 'driveset', secret: SECRET, ttlSeconds: 7200, now: NOW, ...over })
  assert.ok(r.ok)
  return r
}
const verify = (token: unknown, over: Partial<Parameters<typeof verifyTestSessionToken>[1]> = {}) => verifyTestSessionToken(token, { project: 'driveset', secrets, now: NOW + 1000, ...over })
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>
/** A correctly signed token for an arbitrary payload (to test the verifier's own checks). */
const forge = (payload: unknown, secret = SECRET) => {
  const p = b64(JSON.stringify(payload))
  return `${TOKEN_PREFIX}.${p}.${createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${p}`).digest('base64url')}`
}
const good = { v: 1, p: 'driveset', iat: NOW / 1000, exp: NOW / 1000 + 7200, sid: b64('0123456789abcdef'), k: 1 }

test('a valid token verifies and reports project, times, session id and key version', () => {
  const t = issue()
  const v = verify(t.token)
  assert.ok(v.valid)
  assert.deepEqual([v.project, v.keyVersion, v.sessionId], ['driveset', 1, t.sessionId])
  assert.equal(v.issuedAt.toISOString(), '2026-10-05T12:00:00.000Z')
  assert.equal(v.expiresAt.toISOString(), '2026-10-05T14:00:00.000Z')
})

test('format: olnoo-t1.<payload>.<signature>; payload has exactly v,p,iat,exp,sid,k; signing input is "olnoo-t1." + payloadB64 (HMAC-SHA256)', () => {
  const t = issue()
  const parts = t.token.split('.')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], 'olnoo-t1')
  assert.ok(!t.token.includes('=')) // no base64 padding
  assert.deepEqual(Object.keys(decode(t.token)).sort(), ['exp', 'iat', 'k', 'p', 'sid', 'v'])
  assert.deepEqual(decode(t.token), { v: 1, p: 'driveset', iat: NOW / 1000, exp: NOW / 1000 + 7200, sid: t.sessionId, k: 1 })
  const expected = createHmac('sha256', SECRET).update(`olnoo-t1.${parts[1]}`).digest('base64url')
  assert.equal(parts[2], expected)
  assert.equal(Buffer.from(parts[2], 'base64url').length, 32)
})

test('no secret and no personal data inside the token', () => {
  const t = issue()
  const decoded = JSON.stringify(decode(t.token))
  assert.ok(!t.token.includes(SECRET) && !decoded.includes(SECRET))
  assert.ok(!Buffer.from(t.token.split('.')[1], 'base64url').toString().includes(SECRET))
})

test('session id: random, non-empty, at least 16 bytes; the same input twice gives a different sid and token', () => {
  const a = issue()
  const b = issue()
  assert.ok(Buffer.from(a.sessionId, 'base64url').length >= 16)
  assert.notEqual(a.sessionId, b.sessionId)
  assert.notEqual(a.token, b.token)
  const fixed = issue({ randomBytes: (n) => Buffer.alloc(n, 7) })
  assert.equal(fixed.sessionId, Buffer.alloc(16, 7).toString('base64url')) // injectable for deterministic tests
})

test('payload tampering → bad_signature; signature tampering → bad_signature', () => {
  const t = issue().token
  const [prefix, payload, sig] = t.split('.')
  const changed = decode(t)
  changed.exp = (changed.exp as number) + 86400
  assert.deepEqual(verify(`${prefix}.${b64(JSON.stringify(changed))}.${sig}`), { valid: false, reason: 'bad_signature' })
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
  assert.deepEqual(verify(`${prefix}.${payload}.${flipped}`), { valid: false, reason: 'bad_signature' })
  assert.deepEqual(verify(`${prefix}.${payload}.${b64(Buffer.alloc(16))}`), { valid: false, reason: 'bad_signature' }) // wrong length
  assert.deepEqual(verify(t, { secrets: { 1: OTHER_SECRET } }), { valid: false, reason: 'bad_signature' }) // wrong secret
})

test('expired: exactly at exp and later; valid one second before', () => {
  const t = issue({ ttlSeconds: 60 }).token
  assert.ok(verify(t, { now: NOW + 59_000 }).valid)
  assert.deepEqual(verify(t, { now: NOW + 60_000 }), { valid: false, reason: 'expired' })
  assert.deepEqual(verify(t, { now: NOW + 10 * 3600_000 }), { valid: false, reason: 'expired' })
})

test('project binding: a token of project A is not valid as project B (even with the same secret)', () => {
  const a = issue({ project: 'driveset' }).token
  assert.deepEqual(verify(a, { project: 'other' }), { valid: false, reason: 'wrong_project' })
  const b = issueTestSessionToken({ project: 'other', secret: OTHER_SECRET, ttlSeconds: 60, now: NOW })
  assert.ok(b.ok)
  assert.deepEqual(verify(b.token, { project: 'driveset' }), { valid: false, reason: 'wrong_project' })
  assert.ok(verify(b.token, { project: 'other', secrets: { 1: OTHER_SECRET } }).valid)
})

test('unsupported version and unsupported key version', () => {
  assert.deepEqual(verify(forge({ ...good, v: 2 })), { valid: false, reason: 'unsupported_version' })
  assert.deepEqual(verify(forge({ ...good, v: 0 })), { valid: false, reason: 'unsupported_version' })
  assert.deepEqual(verify(forge({ ...good, k: 2 })), { valid: false, reason: 'unsupported_key_version' })
  // rotation: both key versions can be accepted at once
  const rotated = { 1: SECRET, 2: OTHER_SECRET }
  assert.ok(verify(forge({ ...good, k: 2 }, OTHER_SECRET), { secrets: rotated }).valid)
  assert.ok(verify(forge({ ...good, k: 1 }), { secrets: rotated }).valid)
  const k2 = issue({ keyVersion: 2, secret: OTHER_SECRET })
  assert.equal(decode(k2.token).k, 2)
})

test('secret missing → secret_not_configured (verify) / issue refuses; a too-short secret is not usable', () => {
  assert.deepEqual(verify(issue().token, { secrets: { 1: undefined } }), { valid: false, reason: 'secret_not_configured' })
  assert.deepEqual(verify(issue().token, { secrets: { 1: '' } }), { valid: false, reason: 'secret_not_configured' })
  assert.deepEqual(verify(issue().token, { secrets: { 1: 'short' } }), { valid: false, reason: 'secret_not_configured' })
  assert.deepEqual(issueTestSessionToken({ project: 'driveset', secret: undefined, ttlSeconds: 60 }), { ok: false, reason: 'secret_not_configured' })
  assert.deepEqual(issueTestSessionToken({ project: 'driveset', secret: 'short', ttlSeconds: 60 }), { ok: false, reason: 'secret_not_configured' })
})

test('ttl bounds in the library: 1 s … 12 h; zero, negative, fractional, NaN and too large are refused', () => {
  assert.ok(issue({ ttlSeconds: 1 }))
  assert.ok(issue({ ttlSeconds: MAX_TTL_SECONDS }))
  for (const ttlSeconds of [0, -1, 1.5, NaN, Infinity, MAX_TTL_SECONDS + 1, '60' as unknown as number]) {
    assert.deepEqual(issueTestSessionToken({ project: 'driveset', secret: SECRET, ttlSeconds }), { ok: false, reason: 'invalid_ttl' }, String(ttlSeconds))
  }
  assert.deepEqual(issueTestSessionToken({ project: 'bad slug', secret: SECRET, ttlSeconds: 60 }), { ok: false, reason: 'invalid_project' })
})

test('malformed input never throws and is always {valid:false, reason:malformed}', () => {
  const p = b64(JSON.stringify(good))
  const cases: unknown[] = [
    undefined, null, 42, {}, '', 'x', 'olnoo-t1', 'olnoo-t1.a', 'olnoo-t1.a.b.c', `wrong.${p}.sig`, `olnoo-t1..sig`, `olnoo-t1.${p}.`,
    `olnoo-t1.!!!.sig`, `olnoo-t1.${p}.s!g`, `olnoo-t1.${p}=.sig`, 'olnoo-t1.' + b64('not json') + '.sig', 'olnoo-t1.' + b64('[]') + '.sig', 'olnoo-t1.' + b64('null') + '.sig', 'olnoo-t1.' + b64('"s"') + '.sig',
    'x'.repeat(5000), `olnoo-t1.${p}.${'A'.repeat(43)}\n`,
  ]
  for (const c of cases) assert.deepEqual(verify(c), { valid: false, reason: 'malformed' }, JSON.stringify(c)?.slice(0, 40))
})

test('strict payload: missing/extra fields, wrong types, non-integers, exp <= iat, short or non-base64url sid are malformed (even when correctly signed)', () => {
  for (const [name, payload] of [
    ['missing sid', (({ sid: _s, ...rest }) => rest)(good)], ['missing k', (({ k: _k, ...rest }) => rest)(good)], ['extra field', { ...good, extra: 1 }],
    ['v string', { ...good, v: '1' }], ['k string', { ...good, k: '1' }], ['iat string', { ...good, iat: String(good.iat) }], ['exp float', { ...good, exp: good.exp + 0.5 }],
    ['iat NaN', { ...good, iat: null }], ['exp == iat', { ...good, exp: good.iat }], ['exp < iat', { ...good, exp: good.iat - 5 }],
    ['sid empty', { ...good, sid: '' }], ['sid short', { ...good, sid: b64('short') }], ['sid not b64url', { ...good, sid: 'a b'.padEnd(30, 'x') }], ['sid number', { ...good, sid: 5 }],
    ['p empty', { ...good, p: '' }], ['p not a slug', { ...good, p: 'a/../b' }], ['p number', { ...good, p: 1 }], ['k zero', { ...good, k: 0 }],
  ] as [string, unknown][]) {
    assert.deepEqual(verify(forge(payload)), { valid: false, reason: 'malformed' }, name)
  }
})

test('errors and results never contain the token or a secret', () => {
  const t = issue().token
  const outputs = [verify(t.slice(0, -2) + 'AA'), verify(t, { secrets: { 1: undefined } }), verify(t, { now: NOW + 10 ** 10 }), issueTestSessionToken({ project: 'driveset', secret: 'short', ttlSeconds: 60 })]
  for (const out of outputs) {
    const text = JSON.stringify(out)
    assert.ok(!text.includes(t) && !text.includes(SECRET) && !text.includes('short'))
  }
})

test('the token module is portable and uses a timing-safe comparison', () => {
  const src = readFileSync(new URL('./test-session-token.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['node:crypto']) // nothing else: no Next.js, DB, aliases or env access
  assert.match(src, /timingSafeEqual\(given, expected\)/)
  assert.doesNotMatch(src, /process\.env|console\.|from '@\//)
  assert.doesNotMatch(src, /given\.equals|===\s*expected|expected\s*===/) // never a plain comparison of the signature
})
