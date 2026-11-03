import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { handleOwnTelegramUpdate, intakeGrants, intakeOriginal, privateIntakeSender } from './content-factory-telegram-intake.ts'
import { ownMaterialSourceText, type ContentFactoryItem } from './content-factory-items.ts'
const grants = { '123': ['aurelmar'] }
const message = (id: number) => ({ message_id: id, date: 1793700000, chat: { id: 123, type: 'private' }, from: { id: 123 }, text: 'Точный текст! 🏠 https://example.com' })
test('allowlist and explicit project grants fail closed; only own private chats accepted', () => {
  assert.deepEqual(intakeGrants('invalid'), {})
  assert.deepEqual(intakeGrants('{"123":["*"]}'), {})
  assert.deepEqual(intakeGrants('{"123":["aurelmar"]}'), grants)
  assert.equal(privateIntakeSender(message(1), grants), '123')
  assert.equal(privateIntakeSender({ ...message(1), from: { id: 124 } }, grants), null)
  assert.equal(privateIntakeSender({ ...message(1), chat: { id: 123, type: 'group' } }, grants), null)
})
test('album preserves caption text, ordered largest photos and public forwarded URL', () => {
  const data = intakeOriginal({ '2': { ...message(2), text: undefined, media_group_id: 'album', photo: [{ file_id: 'small2' }, { file_id: 'large2' }] }, '1': { ...message(1), text: undefined, caption: message(1).text, photo: [{ file_id: 'large1' }], forward_origin: { type: 'channel', chat: { username: 'partner' }, message_id: 42 } } })
  assert.equal(data.text, message(1).text)
  assert.deepEqual(data.photos.map((p) => p.file_id), ['large1', 'large2'])
  assert.equal(data.url, 'https://t.me/partner/42')
})
test('unauthorized messages have no database or bot effects; groups fall through to comments', async () => {
  const pool = { query: () => { throw new Error('must not query') } } as unknown as Pool
  const deps = { bot: async () => { throw new Error('must not send') }, photo: async () => Buffer.alloc(0) }
  assert.equal(await handleOwnTelegramUpdate(pool, { message: message(1) }, deps, {}), true)
  assert.equal(await handleOwnTelegramUpdate(pool, { message: { ...message(1), chat: { id: -1, type: 'group' } } }, deps, grants), false)
})
function memory() {
  let pending: Record<string, any> | undefined
  const item: Record<string, any> = { id: 'efc9af39-8afc-4611-9c95-51742d2410e1', project_id: 7, original_image_files: [] }
  let inserts = 0
  const calls: string[] = []
  const query = async (sql: string, values: any[] = []): Promise<any> => {
    calls.push(sql)
    if (sql.includes('FROM projects pr')) return { rows: [{ id: 7, name: 'AURELMAR', slug: 'aurelmar' }] }
    if (sql.startsWith('INSERT INTO content_factory_telegram_intake')) {
      const payload = JSON.parse(values[5])
      if (!pending) pending = { id: values[0], sender_id: values[1], chat_id: values[2], messages: {}, item_id: null, project_id: null, completed: false }
      if (!pending.item_id) pending.messages[values[4]] = payload
      return { rows: [pending] }
    }
    if (sql.startsWith('SELECT * FROM content_factory_telegram_intake')) return { rows: pending && values[0] === pending.id && values[1] === pending.sender_id ? [pending] : [] }
    if (sql.startsWith('SELECT id FROM projects')) return { rows: [{ id: 7 }] }
    if (sql.startsWith('SELECT * FROM content_factory_sources')) return { rows: [] }
    if (sql.startsWith('INSERT INTO content_factory_sources')) return { rows: [{ id: 'source', project_id: 7, handle: 'own-bot:123' }] }
    if (sql.startsWith('INSERT INTO content_factory_items')) { inserts++; item.original_text = values[5]; return { rows: [item] } }
    if (sql.startsWith('SELECT original_image_files')) return { rows: [item] }
    if (sql.includes('SET item_id =')) { pending!.item_id = values[0]; pending!.project_id = values[1] }
    if (sql.includes('SET original_image_files =')) item.original_image_files = JSON.parse(values[0])
    if (sql.includes('SET completed = true')) pending!.completed = true
    return { rows: [], rowCount: 1 }
  }
  return { pool: { query, connect: async () => ({ query, release() {} }) } as unknown as Pool, pending: () => pending!, item, inserts: () => inserts, calls }
}
test('text intake selects an allowed project and repeated updates/callbacks create only one item', async () => {
  const db = memory(); const replies: any[] = []
  const deps = { bot: async (_method: string, data: any) => { replies.push(data); return {} }, photo: async () => Buffer.alloc(0) }
  await handleOwnTelegramUpdate(db.pool, { message: message(1) }, deps, grants)
  await handleOwnTelegramUpdate(db.pool, { message: message(1) }, deps, grants)
  const callback = (project: number) => ({ callback_query: { id: 'cb', from: { id: 123 }, message: { ...message(10), from: { id: 999 } }, data: `cfi:${db.pending().id}:${project}:1` } })
  await handleOwnTelegramUpdate(db.pool, callback(999), deps, grants)
  assert.equal(db.inserts(), 0)
  await handleOwnTelegramUpdate(db.pool, callback(7), deps, grants)
  await handleOwnTelegramUpdate(db.pool, callback(7), deps, grants)
  assert.equal(db.inserts(), 1)
  assert.equal(db.item.original_text, message(1).text)
  assert.ok(replies.some((r) => r.text?.includes('уже добавлен')))
})
test('album photo failure keeps earlier files and retry resumes without duplicate item', async () => {
  const db = memory(); let fail = true; const downloads: string[] = []
  const deps = { bot: async () => ({}), photo: async (id: string) => { downloads.push(id); if (id === 'second' && fail) throw new Error('network'); return Buffer.from(id) }, save: async (_p: number, _i: string, bytes: Buffer) => `${bytes.toString()}.jpg` }
  for (const [id, photo] of [[1, 'first'], [2, 'second']] as const) await handleOwnTelegramUpdate(db.pool, { message: { ...message(id), text: undefined, caption: id === 1 ? 'Original caption' : undefined, media_group_id: 'group', photo: [{ file_id: photo }] } }, deps, grants)
  const callback = { callback_query: { id: 'cb', from: { id: 123 }, message: message(10), data: `cfi:${db.pending().id}:7:2` } }
  await handleOwnTelegramUpdate(db.pool, callback, deps, grants)
  assert.deepEqual(db.item.original_image_files, ['first.jpg'])
  assert.equal(db.pending().completed, false)
  fail = false
  await handleOwnTelegramUpdate(db.pool, callback, deps, grants)
  assert.equal(db.inserts(), 1)
  assert.deepEqual(db.item.original_image_files, ['first.jpg', 'second.jpg'])
  assert.deepEqual(downloads, ['first', 'second', 'second'])
  assert.equal(db.pending().completed, true)
})
test('own brief adds context without changing original text; ordinary sources stay unchanged', () => {
  const item = { originalText: 'Original', ownBrief: 'Owner facts', originKind: 'own' } as ContentFactoryItem
  assert.equal(ownMaterialSourceText(item), 'Original\n\nOwner-provided context:\nOwner facts')
  assert.equal(item.originalText, 'Original')
  assert.equal(ownMaterialSourceText({ ...item, originKind: 'source' }), 'Original')
})

test('another allowlisted sender cannot import someone else’s pending material; stale album menu is refused', async () => {
  const db = memory()
  const deps = { bot: async () => ({}), photo: async () => Buffer.alloc(0) }
  await handleOwnTelegramUpdate(db.pool, { message: message(1) }, deps, grants)
  await handleOwnTelegramUpdate(db.pool, { callback_query: { id: 'cb', from: { id: 456 }, message: { ...message(10), chat: { id: 456, type: 'private' } }, data: `cfi:${db.pending().id}:7:1` } }, deps, { ...grants, '456': ['aurelmar'] })
  assert.equal(db.inserts(), 0)
  await handleOwnTelegramUpdate(db.pool, { callback_query: { id: 'cb', from: { id: 123 }, message: message(10), data: `cfi:${db.pending().id}:7:2` } }, deps, grants)
  assert.equal(db.inserts(), 0)
})
test('video with a caption is rejected, not mistaken for supported text/photo intake', async () => {
  const db = memory(); const replies: any[] = []
  await handleOwnTelegramUpdate(db.pool, { message: { ...message(1), text: undefined, caption: 'Video caption', video: {} } }, { bot: async (_m, data) => { replies.push(data); return {} }, photo: async () => Buffer.alloc(0) }, grants)
  assert.equal(db.pending(), undefined)
  assert.ok(replies.some((r) => r.text.includes('не поддерживаются')))
})
