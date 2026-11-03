import test from 'node:test'
import assert from 'node:assert/strict'
import { sendTelegramPhotoWithText, sendTelegramAlbumWithText } from './social-telegram-photo.ts'

const image = Buffer.from([0xff, 0xd8, 0xff])
const base = { baseUrl: 'https://telegram.example', token: 'test', chatId: '@channel', image }
const ok = (id: number) => new Response(JSON.stringify({ ok: true, result: { message_id: id } }), { status: 200 })

test('short post is sent as one photo with its full caption', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const result = await sendTelegramPhotoWithText({ ...base, text: 'Short post', fetchImpl: (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return ok(42)
  }) as typeof fetch })
  assert.deepEqual(result, { kind: 'sent', messageId: 42 })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /sendPhoto$/)
  assert.equal((calls[0].init.body as FormData).get('caption'), 'Short post')
})

test('long post sends photo and then the complete text separately', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const text = 'A'.repeat(1200)
  const result = await sendTelegramPhotoWithText({ ...base, text, fetchImpl: (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return ok(calls.length)
  }) as typeof fetch })
  assert.deepEqual(result, { kind: 'sent', messageId: 1 })
  assert.equal(calls.length, 2)
  assert.equal((calls[0].init.body as FormData).get('caption'), null)
  assert.match(calls[1].url, /sendMessage$/)
  assert.equal(JSON.parse(calls[1].init.body as string).text, text)
})

test('a rejected photo is a confirmed failure without a text send', async () => {
  let calls = 0
  const result = await sendTelegramPhotoWithText({ ...base, text: 'A'.repeat(1200), fetchImpl: (async () => {
    calls++
    return new Response(JSON.stringify({ ok: false, description: 'Forbidden' }), { status: 403 })
  }) as typeof fetch })
  assert.deepEqual(result, { kind: 'failed', error: 'Forbidden' })
  assert.equal(calls, 1)
})

test('a failure after photo delivery is unknown and cannot be safely replayed', async () => {
  let calls = 0
  const result = await sendTelegramPhotoWithText({ ...base, text: 'A'.repeat(1200), fetchImpl: (async () => {
    calls++
    return calls === 1 ? ok(42) : new Response(JSON.stringify({ ok: false, description: 'Text rejected' }), { status: 400 })
  }) as typeof fetch })
  assert.equal(result.kind, 'unknown')
  assert.match(result.error, /Image was sent.*Check Telegram before any retry/)
  assert.equal(calls, 2)
})

test('unknown photo result is not followed by a text send', async () => {
  let calls = 0
  const result = await sendTelegramPhotoWithText({ ...base, text: 'A'.repeat(1200), fetchImpl: (async () => {
    calls++
    throw new Error('timeout')
  }) as typeof fetch })
  assert.equal(result.kind, 'unknown')
  assert.equal(calls, 1)
})

test('oversized text is refused before sending the photo', async () => {
  const result = await sendTelegramPhotoWithText({ ...base, text: 'A'.repeat(4097), fetchImpl: (async () => {
    throw new Error('should not send')
  }) as typeof fetch })
  assert.equal(result.kind, 'failed')
})

test('album sends ordered photos with unchanged caption on first image only', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const result = await sendTelegramAlbumWithText({ ...base, text: 'Original! 🏠', images: [
    { bytes: image, mimeType: 'image/jpeg' }, { bytes: image, mimeType: 'image/jpeg' },
  ], fetchImpl: (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true, result: [{ message_id: 41 }, { message_id: 42 }] }), { status: 200 })
  }) as typeof fetch })
  assert.deepEqual(result, { kind: 'sent', messageId: 41 })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /sendMediaGroup$/)
  const form = calls[0].init.body as FormData
  const media = JSON.parse(form.get('media') as string)
  assert.equal(media[0].caption, 'Original! 🏠')
  assert.equal(media[1].caption, undefined)
  assert.equal((form.get('photo0') as File).name, 'original0.jpg')
  assert.equal((form.get('photo1') as File).name, 'original1.jpg')
})

test('long album caption sends full text separately and blocks replay if text outcome is unknown', async () => {
  let calls = 0
  const result = await sendTelegramAlbumWithText({ ...base, text: 'A'.repeat(1200), images: [
    { bytes: image, mimeType: 'image/jpeg' }, { bytes: image, mimeType: 'image/jpeg' },
  ], fetchImpl: (async () => {
    calls++
    if (calls === 1) return new Response(JSON.stringify({ ok: true, result: [{ message_id: 41 }, { message_id: 42 }] }), { status: 200 })
    throw new Error('timeout')
  }) as typeof fetch })
  assert.equal(result.kind, 'unknown')
  assert.equal(calls, 2)
})

test('album rejection is a confirmed failure', async () => {
  const result = await sendTelegramAlbumWithText({ ...base, text: 'Post', images: [
    { bytes: image, mimeType: 'image/jpeg' }, { bytes: image, mimeType: 'image/jpeg' },
  ], fetchImpl: (async () => new Response(JSON.stringify({ ok: false, description: 'Forbidden' }), { status: 403 })) as typeof fetch })
  assert.deepEqual(result, { kind: 'failed', error: 'Forbidden' })
})
