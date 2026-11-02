import test from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import type { Pool } from 'pg'
import { buildContentFactoryImagePrompt, contentFactoryImagePath, generateContentFactoryCover } from './content-factory-image.ts'
import { callAiRouterImage, AiRouterError } from './ai-router.ts'

test('cover prompt asks for a photographic scene, not a banner or source image', () => {
  const prompt = buildContentFactoryImagePrompt('New market', 'restrained editorial style')
  assert.match(prompt, /New market/)
  assert.match(prompt, /restrained editorial style/)
  assert.match(prompt, /1024x1024/)
  assert.match(prompt, /editorial photograph or photorealistic illustration/)
  assert.match(prompt, /not an advertisement, promotional banner/)
  assert.match(prompt, /NO text, letters, digits, logos, signs, labels, interfaces, charts, diagrams or watermarks/)
  assert.match(prompt, /architecture, urban settings, buildings or interiors/)
  assert.match(prompt, /Never depict an identifiable specific property as a real project without confirmation/)
  assert.match(prompt, /Do not copy, imitate or reference any image from the source publication/)
})

test('image storage path rejects traversal and stays under uploads', () => {
  assert.match(contentFactoryImagePath('olnoo', '11111111-1111-1111-1111-111111111111.jpg'), /uploads\/content-factory\/olnoo\/11111111-1111-1111-1111-111111111111.jpg$/)
  assert.throws(() => contentFactoryImagePath('../other', '11111111-1111-1111-1111-111111111111.jpg'))
  assert.throws(() => contentFactoryImagePath('olnoo', '../secret.jpg'))
})

test('Router image client calls the supported text-to-image route at 1024x1024', async () => {
  const original = globalThis.fetch
  let request: { url: string; body: Record<string, unknown> } | null = null
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    request = { url, body: JSON.parse(init.body as string) }
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    return new Response(JSON.stringify({ mimeType: 'image/png', imageBase64: png.toString('base64') }))
  }) as typeof fetch
  try {
    await callAiRouterImage('Original cover')
    assert.match(request!.url, /\/v1\/images\/generate$/)
    assert.deepEqual(request!.body, { prompt: 'Original cover', size: '1024x1024' })
  } finally {
    globalThis.fetch = original
  }
})

test('Router image client rejects a non-image response', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ mimeType: 'image/png', imageBase64: 'invalid' }))) as typeof fetch
  try {
    await assert.rejects(() => callAiRouterImage('Cover'), AiRouterError)
  } finally {
    globalThis.fetch = original
  }
})

test('generated cover validates 1024x1024 and converts Router PNG to Telegram-ready JPEG', async () => {
  const original = globalThis.fetch
  const image = new Jimp({ width: 1024, height: 1024, color: 0xffffffff })
  const png = await image.getBuffer('image/png')
  const pool = { query: async (sql: string) => sql.includes('FROM project_brand_voice')
    ? { rows: [{ target_audience: 'Investors', tone_style: 'restrained editorial style', verified_facts: '', constraints: 'No investment promises', preferred_cta: 'Contact us' }] }
    : { rows: [] } } as unknown as Pool
  let sentPrompt = ''
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sentPrompt = JSON.parse(init.body as string).prompt
    return new Response(JSON.stringify({ mimeType: 'image/png', imageBase64: png.toString('base64') }))
  }) as typeof fetch
  try {
    const jpeg = await generateContentFactoryCover(pool, 1, 'Independent title', 'Finished article')
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff])
    assert.match(sentPrompt, /Independent title/)
    assert.doesNotMatch(sentPrompt, /Finished article/)
    assert.match(sentPrompt, /restrained editorial style/)
    assert.match(sentPrompt, /No investment promises/)
    assert.doesNotMatch(sentPrompt, /Contact us/)
  } finally {
    globalThis.fetch = original
  }
})

test('generated cover rejects a Router image with the wrong dimensions', async () => {
  const original = globalThis.fetch
  const image = new Jimp({ width: 512, height: 512, color: 0xffffffff })
  const png = await image.getBuffer('image/png')
  const pool = { query: async (sql: string) => sql.includes('FROM project_brand_voice')
    ? { rows: [{ target_audience: 'Investors', tone_style: 'restrained editorial style', verified_facts: '', constraints: '', preferred_cta: '' }] }
    : { rows: [] } } as unknown as Pool
  globalThis.fetch = (async () => new Response(JSON.stringify({ mimeType: 'image/png', imageBase64: png.toString('base64') }))) as typeof fetch
  try {
    await assert.rejects(() => generateContentFactoryCover(pool, 1, 'Title', 'Article'), /wrong dimensions/)
  } finally {
    globalThis.fetch = original
  }
})
