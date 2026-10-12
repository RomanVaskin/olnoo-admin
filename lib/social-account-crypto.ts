import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Encrypts social_accounts' per-account platform credentials (currently just VK's access token) at
// rest. AES-256-GCM: a fresh random 12-byte IV per encryption, the 16-byte auth tag appended so
// tampering/corruption is detected on decrypt rather than silently returning garbage. Stored as a
// single base64 string: iv (12 bytes) + tag (16 bytes) + ciphertext.
//
// Key: server-only env var SOCIAL_ACCOUNT_ENCRYPTION_KEY, base64-encoded, exactly 32 bytes once
// decoded (AES-256). Never stored in Postgres or Git, never sent to the browser — same convention
// as every other secret in this app (VK_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, ...). Unset or malformed
// fails closed: encrypting or decrypting throws rather than falling back to storing/reading
// plaintext or guessing a key.

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

function resolveKey(): Buffer {
  const raw = process.env.SOCIAL_ACCOUNT_ENCRYPTION_KEY
  if (!raw) {
    throw new Error('SOCIAL_ACCOUNT_ENCRYPTION_KEY is not configured on the server')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('SOCIAL_ACCOUNT_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded AES-256 key)')
  }
  return key
}

export function encryptAccountSecret(plaintext: string): string {
  const key = resolveKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptAccountSecret(stored: string): string {
  const key = resolveKey()
  const buf = Buffer.from(stored, 'base64')
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Stored credential is corrupt (too short to contain iv+tag)')
  }
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
