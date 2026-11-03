import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { approveLanguage, copyImagesReady, selectedTelegramAccount, TRANSLATE_EN_PROMPT, validateEnglishTranslation } from './content-factory-languages.ts'
import type { ContentFactoryItem } from './content-factory-items.ts'

test('translator instructions require a complete English post and preserve links, facts and presentation', () => {
  for (const term of ['complete English post', 'section', 'list', 'fact', 'price', 'number', 'URL', 'emoji', 'Do not summarize', 'no project-specific replacement rule']) {
    assert.ok(TRANSLATE_EN_PROMPT.includes(term), term)
  }
})

test('translation gate preserves numerical facts, links and emoji', () => {
  const ru = 'Цена 123 USD. 🏠\nhttps://example.com/contact'
  validateEnglishTranslation(ru, 'Price 123 USD. 🏠\nhttps://example.com/contact')
  assert.throws(() => validateEnglishTranslation(ru, 'Price 124 USD. 🏠\nhttps://example.com/contact'), /number/)
  assert.throws(() => validateEnglishTranslation(ru, 'Price 123 USD. 🏠\nhttps://example.com/other'), /link/)
  assert.throws(() => validateEnglishTranslation(ru, 'Price 123 USD.\nhttps://example.com/contact'), /emoji/)
})

test('four-photo partner copy requires all saved originals before either language can publish', () => {
  const item = { processingMode: 'copy', copyPermissionConfirmed: true, originalImageUrls: ['1', '2', '3', '4'], originalImageFiles: ['a', 'b', 'c', 'd'], originalImageError: '', originalText: 'Original', generatedText: 'Original', imageFilename: '' } as ContentFactoryItem
  assert.equal(copyImagesReady(item), true)
  assert.equal(copyImagesReady({ ...item, originalImageFiles: ['a', 'b', 'c'] }), false)
  assert.equal(copyImagesReady({ ...item, originalImageError: 'fourth image failed' }), false)
  assert.equal(copyImagesReady({ ...item, generatedText: 'Changed' }), false)
  assert.equal(copyImagesReady({ ...item, processingMode: 'ai' }), true)
})

test('EN may be approved independently of RU for a complete four-photo partner post', async () => {
  const russian = 'Цена 123 USD. 🏠 https://example.com/contact'
  const english = 'Price 123 USD. 🏠 https://example.com/contact'
  const item = { id: 'item', projectId: 7, status: 'needs_review', processingMode: 'copy', copyPermissionConfirmed: true,
    copyApprovedAt: null, originalText: russian, generatedText: russian, originalImageUrls: ['1', '2', '3', '4'],
    originalImageFiles: ['a', 'b', 'c', 'd'], originalImageError: '', imageFilename: '', enText: english,
    enSourceText: russian, enRightsConfirmed: true, enSocialPostId: null } as unknown as ContentFactoryItem
  const statements: string[] = []
  const pool = { query: async (sql: string) => {
    statements.push(sql)
    if (sql.includes('FROM social_accounts')) return { rows: [{ id: 'en', username: '@aurelmar_en' }] }
    if (sql.startsWith('SELECT * FROM content_factory_items')) return { rows: [{ id: 'item', project_id: 7, en_approved_at: '2026-11-03T00:00:00Z' }] }
    return { rows: [], rowCount: 1 }
  } } as unknown as Pool
  const approved = await approveLanguage(pool, item, 'en', 'en', true)
  assert.ok(approved.enApprovedAt)
  assert.ok(statements.some((sql) => sql.includes('SET en_account_id')))
  assert.ok(statements.some((sql) => sql.includes('SET en_approved_at')))
  assert.ok(!statements.some((sql) => sql.includes('copy_approved_at = now()')))
})

test('a selected account is project-scoped and bot access is verified before send', async () => {
  const sqls: string[] = []
  const pool = { query: async (sql: string, values: unknown[]) => {
    sqls.push(sql)
    assert.deepEqual(values, ['account-en', 7])
    return { rows: [{ id: 'account-en', username: '@aurelmar_en' }] }
  } } as unknown as Pool
  const previous = process.env.TELEGRAM_BOT_TOKEN
  const fetchBefore = globalThis.fetch
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  globalThis.fetch = (async (input: string) => {
    if (input.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { id: 123 } }))
    if (input.includes('/getChatMember')) return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }))
    return new Response(JSON.stringify({ ok: true, result: { id: -1001, type: 'channel' } }))
  }) as typeof fetch
  try {
    await assert.rejects(() => selectedTelegramAccount(pool, 7, 'account-en', true), /Bot cannot publish.*not an admin/)
    assert.match(sqls[0], /project_id = \$2/)
  } finally {
    globalThis.fetch = fetchBefore
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = previous
  }
})
