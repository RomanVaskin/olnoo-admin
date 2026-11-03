import test from 'node:test'
import assert from 'node:assert/strict'
import { loadLanguageMedia } from './content-factory-language-media.ts'
import type { ContentFactoryItem } from './content-factory-items.ts'

test('four partner photos retain order and bytes for both RU and EN', async () => {
  const names = ['one.jpg', 'two.png', 'three.jpg', 'four.jpg']
  const bytes = names.map((_, index) => Buffer.from([index + 1, 17, 42]))
  const item = { id: 'item', projectId: 7, processingMode: 'copy', originalImageFiles: names,
    originalImageUrls: ['u1', 'u2', 'u3', 'u4'], originalImageError: '' } as unknown as ContentFactoryItem
  const reader = async (_projectId: number, _itemId: string, filename: string) => bytes[names.indexOf(filename)]
  const ru = await loadLanguageMedia(item, 'aurelmar', 'ru', { original: reader })
  const en = await loadLanguageMedia(item, 'aurelmar', 'en', { original: reader })
  assert.deepEqual(ru.images.map((image) => image.bytes), bytes)
  assert.deepEqual(en.images.map((image) => image.bytes), bytes)
  assert.deepEqual(en.images.map((image) => image.mimeType), ['image/jpeg', 'image/png', 'image/jpeg', 'image/jpeg'])
  assert.equal(ru.photo, undefined)
  assert.equal(en.photo, undefined)
  await assert.rejects(() => loadLanguageMedia({ ...item, originalImageFiles: names.slice(0, 3) }, 'aurelmar', 'en', { original: reader }), /incomplete/)
})

test('AI posts reuse the same cover in both languages', async () => {
  const cover = Buffer.from([5, 6, 7])
  const item = { processingMode: 'ai', imageFilename: 'cover.jpg' } as ContentFactoryItem
  const reader = async () => cover
  assert.deepEqual(await loadLanguageMedia(item, 'aurelmar', 'en', { cover: reader }), { images: [], photo: cover })
  assert.deepEqual(await loadLanguageMedia(item, 'aurelmar', 'ru', { cover: reader }), { images: [], photo: cover })
})
