import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'
import { downloadOriginalImage, originalImagePath, readOriginalImage, syncOriginalImages } from './content-factory-original-images.ts'
import type { ContentFactoryItem } from './content-factory-items.ts'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00])
const url = 'https://cdn4.telesco.pe/file/one.jpg'

test('source downloader accepts Telegram JPEG and rejects external hosts and non-image bytes', async () => {
  const fetchImpl = (async () => new Response(new Uint8Array(jpeg), { status: 200 })) as typeof fetch
  assert.deepEqual(await downloadOriginalImage(url, fetchImpl), { bytes: jpeg, extension: 'jpg' })
  await assert.rejects(() => downloadOriginalImage('https://example.com/photo.jpg', fetchImpl), /allowed Telegram media host/)
  await assert.rejects(() => downloadOriginalImage(url, (async () => new Response('not an image')) as typeof fetch), /supported JPEG, PNG or WebP/)
})

test('copy image sync retains first saved image when the second fails, then resumes in order', async () => {
  const id = randomUUID()
  const item = { id, projectId: 1, processingMode: 'copy', originalImageUrls: [url, `${url}?second=1`], originalImageFiles: [], originalImageError: '' } as unknown as ContentFactoryItem
  const saved: string[] = []
  let error = ''
  const pool = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('original_image_files =')) { saved.push(params[0] as string); return { rowCount: 1 } }
    if (sql.includes('original_image_error =')) { error = params[0] as string; return { rowCount: 1 } }
    throw new Error('unexpected query')
  } } as unknown as Pool
  let calls = 0
  const firstFetch = (async () => {
    calls++
    return calls === 1 ? new Response(new Uint8Array(jpeg)) : new Response('failure', { status: 503 })
  }) as typeof fetch
  try {
    assert.match(await syncOriginalImages(pool, item, firstFetch), /Source image 2\/2/)
    assert.equal(saved.length, 1)
    assert.deepEqual(await readOriginalImage(1, id, saved[0]), jpeg)
    assert.match(error, /HTTP 503/)
    assert.equal(await syncOriginalImages(pool, { ...item, originalImageFiles: saved, originalImageError: error }, (async () => new Response(new Uint8Array(jpeg))) as typeof fetch), '')
    assert.equal(saved.length, 2)
    assert.deepEqual(await readOriginalImage(1, id, saved[1]), jpeg)
  } finally {
    await rm(path.dirname(originalImagePath(1, id, `${randomUUID()}.jpg`)), { recursive: true, force: true })
  }
})
