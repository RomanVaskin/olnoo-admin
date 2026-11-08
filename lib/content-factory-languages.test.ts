import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { approveLanguage, copyImagesReady, languageText, selectedTelegramAccount, TRANSLATE_EN_PROMPT, TRANSLATE_RU_PROMPT, translateItem, validateTranslation } from './content-factory-languages.ts'
import { detectPostLanguage, type ContentFactoryItem } from './content-factory-items.ts'

test('translator instructions require a complete English post and preserve links, facts and presentation', () => {
  for (const term of ['complete English post', 'section', 'list', 'fact', 'price', 'number', 'URL', 'emoji', 'Do not summarize', 'no project-specific replacement rule']) {
    assert.ok(TRANSLATE_EN_PROMPT.includes(term), term)
  }
})

test('RU and EN are detected from the prepared text and translated only to the other language', async () => {
  assert.equal(detectPostLanguage('Новый жилой комплекс в центре города. https://example.com'), 'ru')
  assert.equal(detectPostLanguage('A new residential building in the city centre. https://example.com'), 'en')
  assert.equal(detectPostLanguage('12345 https://example.com'), null)
  assert.match(TRANSLATE_RU_PROMPT, /natural Russian/)
  const item = { sourceLanguage: 'en', generatedText: 'English finished post', ruText: 'Готовый русский пост' } as ContentFactoryItem
  assert.equal(languageText(item, 'en'), item.generatedText)
  assert.equal(languageText(item, 'ru'), item.ruText)
  await assert.rejects(() => translateItem({} as Pool, item, 'en', false), /already in this language/)
  await assert.rejects(() => translateItem({} as Pool, item, 'ru', false), /Approve the prepared source/)
})

test('approved partner RU translates to EN without changing the original or four photos', async () => {
  const source = 'Цена 123 USD. 🏠 Подробности https://example.com/contact'
  const output = 'Price 123 USD. 🏠 Details https://example.com/contact'
  const item = { id: 'item', projectId: 7, sourceLanguage: 'ru', processingMode: 'copy',
    generatedText: source, originalText: source, ruApprovedAt: 'now', socialPostId: null, enSocialPostId: null,
    copyPermissionConfirmed: true, originalImageUrls: ['1', '2', '3', '4'], originalImageFiles: ['a', 'b', 'c', 'd'],
    originalImageError: '', imageFilename: '' } as unknown as ContentFactoryItem
  const calls: string[] = []
  const pool = { query: async (sql: string) => {
    calls.push(sql)
    if (sql.startsWith('SELECT *')) return { rows: [{ id: 'item', project_id: 7, source_language: 'ru', generated_text: source, original_text: source, original_image_files: ['a', 'b', 'c', 'd'], original_image_urls: '1,2,3,4' }] }
    return { rows: [{ id: 'item' }], rowCount: 1 }
  } } as unknown as Pool
  await translateItem(pool, item, 'en', true, { projectContext: 'brand', callRouter: async (messages, options) => {
    assert.equal(options?.service, 'content-factory')
    assert.equal(messages[1].content.includes(source), true)
    assert.equal(messages[0].content, TRANSLATE_EN_PROMPT)
    return output
  } })
  assert.ok(calls.some((sql) => sql.includes('SET en_text = $1, en_source_text = generated_text')))
  assert.ok(calls.every((sql) => !sql.includes('SET generated_text =')))
})

test('approved edited AI post in EN translates to RU with the current prepared text', async () => {
  const source = 'Edited final post: price 123 USD. 🏠 https://example.com/contact'
  const output = 'Готовый текст: цена 123 USD. 🏠 https://example.com/contact'
  const item = { id: 'item', projectId: 7, sourceLanguage: 'en', processingMode: 'ai', status: 'ready',
    generatedTitle: 'Edited', generatedText: source, imageFilename: 'cover.png', enApprovedAt: 'now',
    socialPostId: null, enSocialPostId: null, aiReview: { status: 'passed', risk: 'low', passed: true,
      quality: { passed: true, issues: [], recommendations: [] }, reviewedTitle: 'Edited', reviewedText: source,
      reviewedImageFilename: 'cover.png' } } as unknown as ContentFactoryItem
  const calls: string[] = []
  const pool = { query: async (sql: string) => {
    calls.push(sql)
    if (sql.startsWith('SELECT *')) return { rows: [{ id: 'item', project_id: 7, source_language: 'en', generated_text: source, ru_text: output }] }
    return { rows: [{ id: 'item' }], rowCount: 1 }
  } } as unknown as Pool
  await translateItem(pool, item, 'ru', false, { projectContext: 'brand', callRouter: async (messages, options) => {
    assert.equal(options?.service, 'content-factory')
    assert.equal(messages[1].content.includes(source), true)
    assert.equal(messages[0].content, TRANSLATE_RU_PROMPT)
    return output
  } })
  assert.ok(calls.some((sql) => sql.includes('SET ru_text = $1, ru_source_text = generated_text')))
})

test('translation gate preserves numerical facts, links and emoji', () => {
  const ru = 'Цена 123 USD. 🏠\nhttps://example.com/contact'
  validateTranslation(ru, 'Price 123 USD. 🏠\nhttps://example.com/contact')
  assert.throws(() => validateTranslation('Prepared English news for readers.', 'Prepared English news for readers.', 'ru'), /must be written in RU/)
  assert.throws(() => validateTranslation(ru, 'Price 124 USD. 🏠\nhttps://example.com/contact'), /number/)
  assert.throws(() => validateTranslation(ru, 'Price 123 USD. 🏠\nhttps://example.com/other'), /link/)
  assert.throws(() => validateTranslation(ru, 'Price 123 USD.\nhttps://example.com/contact'), /emoji/)
})

test('four-photo partner copy requires all saved originals before either language can publish', () => {
  const item = { processingMode: 'copy', copyPermissionConfirmed: true, originalImageUrls: ['1', '2', '3', '4'], originalImageFiles: ['a', 'b', 'c', 'd'], originalImageError: '', originalText: 'Original', generatedText: 'Original', imageFilename: '' } as ContentFactoryItem
  assert.equal(copyImagesReady(item), true)
  assert.equal(copyImagesReady({ ...item, originalImageFiles: ['a', 'b', 'c'] }), false)
  assert.equal(copyImagesReady({ ...item, originalImageError: 'fourth image failed' }), false)
  assert.equal(copyImagesReady({ ...item, generatedText: 'Changed' }), false)
  assert.equal(copyImagesReady({ ...item, processingMode: 'ai' }), true)
})

test('EN translation approval requires an approved RU source and complete four-photo partner post', async () => {
  const russian = 'Стоимость 123 USD. 🏠 https://example.com/contact'
  const english = 'Price 123 USD. 🏠 https://example.com/contact'
  const item = { id: 'item', projectId: 7, status: 'needs_review', processingMode: 'copy', copyPermissionConfirmed: true,
    copyApprovedAt: 'now', sourceLanguage: 'ru', ruApprovedAt: 'now', originalText: russian, generatedText: russian, originalImageUrls: ['1', '2', '3', '4'],
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

test('EN native and RU translated versions are approved independently', async () => {
  const english = 'Price 123 USD. 🏠 https://example.com/contact'
  const russian = 'Стоимость 123 USD. 🏠 https://example.com/contact'
  const item = { id: 'item', projectId: 7, sourceLanguage: 'en', status: 'ready', processingMode: 'copy',
    generatedText: english, originalText: english, copyPermissionConfirmed: true, copyApprovedAt: 'now',
    originalImageUrls: [], originalImageFiles: [], originalImageError: '', imageFilename: '',
    ruText: russian, ruSourceText: english, ruRightsConfirmed: true, enApprovedAt: 'now',
    socialPostId: null, enSocialPostId: null } as unknown as ContentFactoryItem
  const statements: string[] = []
  const pool = { query: async (sql: string) => {
    statements.push(sql)
    if (sql.includes('FROM social_accounts')) return { rows: [{ id: 'ru', username: '@aurelmar' }] }
    if (sql.startsWith('SELECT * FROM content_factory_items')) return { rows: [{ id: 'item', project_id: 7, source_language: 'en', ru_approved_at: 'now' }] }
    return { rows: [], rowCount: 1 }
  } } as unknown as Pool
  await approveLanguage(pool, item, 'ru', 'ru', true)
  assert.ok(statements.some((sql) => sql.includes('ru_source_text = generated_text')))
  assert.ok(statements.some((sql) => sql.includes('SET ru_approved_at = now()')))
  assert.ok(!statements.some((sql) => sql.includes('SET en_approved_at = now()')))
  await assert.rejects(() => approveLanguage(pool, { ...item, ruSourceText: 'older source text' }, 'ru', 'ru', true), /stale/)
})

test('English original can receive native manual approval without a redundant translation', async () => {
  const english = 'Original partner announcement with details and prices.'
  const item = { id: 'item', projectId: 7, sourceLanguage: 'en', status: 'needs_review', processingMode: 'copy',
    generatedText: english, originalText: english, copyPermissionConfirmed: true, copyApprovedAt: null,
    originalImageUrls: [], originalImageFiles: [], originalImageError: '', imageFilename: '',
    socialPostId: null, enSocialPostId: null } as unknown as ContentFactoryItem
  const calls: string[] = []
  const pool = { query: async (sql: string) => {
    calls.push(sql)
    if (sql.includes('FROM social_accounts')) return { rows: [{ id: 'en', username: '@aurelmar_en' }] }
    if (sql.startsWith('SELECT * FROM content_factory_items')) return { rows: [{ id: 'item', project_id: 7, source_language: 'en', en_approved_at: 'now' }] }
    return { rows: [{ id: 'item' }], rowCount: 1 }
  } } as unknown as Pool
  await approveLanguage(pool, item, 'en', 'en', true)
  assert.ok(calls.some((sql) => sql.includes('copy_approved_at = now()')))
  assert.ok(calls.some((sql) => sql.includes('SET en_approved_at = now()')))
  assert.ok(!calls.some((sql) => sql.includes('SET en_text =')))
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

test('native Monitor copies cannot enter the legacy translation path and silently lose attachments', async () => {
  const text = 'Оригинальный текст'
  const item = { processingMode: 'copy', originalText: text, generatedText: text,
    originalImageError: '', imageFilename: '', originalTelegram: { version: 1, transport: 'mtproto',
      complete: true, peerId: '77', groupedId: null, messageIds: ['101'], messages: [{ id: '101', text, entities: [] }] }
  } as unknown as ContentFactoryItem
  let calls = 0
  await assert.rejects(() => translateItem({ query: async () => { calls++; return { rows: [] } } } as unknown as Pool,
    item, 'en', true, { callRouter: async () => { calls++; return 'translated' } }), /Перевод MTProto-копии пока не поддерживается/)
  assert.equal(calls, 0)
})
