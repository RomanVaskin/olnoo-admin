import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { decryptAccountSecret, encryptAccountSecret } from './social-account-crypto.ts'

const TEST_KEY = randomBytes(32).toString('base64')

test('round-trips a secret through encrypt then decrypt', () => {
  process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY = TEST_KEY
  const ciphertext = encryptAccountSecret('vk1.a.super-secret-token')
  assert.notEqual(ciphertext, 'vk1.a.super-secret-token')
  assert.equal(decryptAccountSecret(ciphertext), 'vk1.a.super-secret-token')
})

test('two encryptions of the same plaintext never produce the same ciphertext (random iv)', () => {
  process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY = TEST_KEY
  const a = encryptAccountSecret('same-token')
  const b = encryptAccountSecret('same-token')
  assert.notEqual(a, b)
  assert.equal(decryptAccountSecret(a), 'same-token')
  assert.equal(decryptAccountSecret(b), 'same-token')
})

test('missing key fails closed on both encrypt and decrypt, never falls back to plaintext', () => {
  delete process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY
  assert.throws(() => encryptAccountSecret('x'), /SOCIAL_ACCOUNT_ENCRYPTION_KEY is not configured/)
  assert.throws(() => decryptAccountSecret('whatever'), /SOCIAL_ACCOUNT_ENCRYPTION_KEY is not configured/)
})

test('a malformed (too-short, non-base64, or wrong-length) key is rejected, not padded or truncated', () => {
  process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64')
  assert.throws(() => encryptAccountSecret('x'), /must decode to exactly 32 bytes/)
  process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY = TEST_KEY
})

test('tampered ciphertext fails to decrypt rather than returning corrupted data', () => {
  process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY = TEST_KEY
  const ciphertext = encryptAccountSecret('vk1.a.super-secret-token')
  const buf = Buffer.from(ciphertext, 'base64')
  buf[buf.length - 1] ^= 0xff // flip the last ciphertext byte
  const tampered = buf.toString('base64')
  assert.throws(() => decryptAccountSecret(tampered))
})

test('ciphertext encrypted under one key cannot be decrypted under a different key', () => {
  process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY = TEST_KEY
  const ciphertext = encryptAccountSecret('vk1.a.super-secret-token')
  process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  assert.throws(() => decryptAccountSecret(ciphertext))
  process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY = TEST_KEY
})
