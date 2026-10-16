import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveRefreshTokenToLocalFile } from './google-ads-oauth-token-store.ts'

test('saveRefreshTokenToLocalFile: writes the refresh token, scope and a timestamp to the given path, creating parent dirs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'google-ads-oauth-test-'))
  const filePath = join(dir, 'nested', 'google-ads-refresh-token.json')
  try {
    const result = await saveRefreshTokenToLocalFile('a-refresh-token-value', 'https://www.googleapis.com/auth/adwords', filePath)
    assert.deepEqual(result, { ok: true, path: filePath })

    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.refreshToken, 'a-refresh-token-value')
    assert.equal(parsed.scope, 'https://www.googleapis.com/auth/adwords')
    assert.ok(typeof parsed.obtainedAt === 'string' && !Number.isNaN(Date.parse(parsed.obtainedAt)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saveRefreshTokenToLocalFile: refuses to overwrite an existing file (atomic create, no clobber)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'google-ads-oauth-test-'))
  const filePath = join(dir, 'google-ads-refresh-token.json')
  try {
    const first = await saveRefreshTokenToLocalFile('first-refresh-token', 'scope-a', filePath)
    assert.equal(first.ok, true)

    const second = await saveRefreshTokenToLocalFile('second-refresh-token', 'scope-b', filePath)
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.ok(!second.error.includes('second-refresh-token'))
    }

    // The original file's contents must be untouched by the rejected second write.
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.refreshToken, 'first-refresh-token')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saveRefreshTokenToLocalFile: returns ok:false with a generic error (never throws) when the path cannot be written', async () => {
  // A path nested under a file (not a directory) can never be created as a directory.
  const dir = await mkdtemp(join(tmpdir(), 'google-ads-oauth-test-'))
  const blockerFile = join(dir, 'blocker')
  await (await import('node:fs/promises')).writeFile(blockerFile, 'not a directory')
  const impossiblePath = join(blockerFile, 'google-ads-refresh-token.json')
  try {
    const result = await saveRefreshTokenToLocalFile('a-refresh-token-value', 'scope', impossiblePath)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(!result.error.includes('a-refresh-token-value'))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
