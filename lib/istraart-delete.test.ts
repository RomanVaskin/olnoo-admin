import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Pool } from 'pg'
import ts from 'typescript'
import * as deletion from './istraart-delete.ts'
import * as catalogExport from './catalog-export.ts'
import * as schema from './catalog-schema.ts'

const cardId = '00000000-0000-4000-8000-000000000001'
const guideId = '00000000-0000-4000-8000-000000000002'
const otherId = '00000000-0000-4000-8000-000000000003'
const token = 'a'.repeat(40)
function harness() {
  const items = new Map(['source', 'second', 'foreign'].map((id) => [id, { id, project_id: id === 'foreign' ? 2 : 1, status: 'new', en_publish_claimed: false, en_social_post_id: null as string | null }]))
  const cards = new Map<string, Record<string, any>>()
  const social = [{ id: 'social-post', project_id: 1, text: 'Published Telegram post' }]
  const files = new Map([['original.jpg', Buffer.from('original')], ['other.jpg', Buffer.from('other')]])
  const calls: { sql: string; values: any[] }[] = []
  let fkRace = false
  let unavailable = false
  let releases = 0
  function add(id = cardId, source = 'source', project = 1, parent: string | null = null) {
    const row = { id, content_item_id: source, item_id: source, project_id: project, card_kind: parent ? 'guide' : 'finished', parent_card_id: parent,
      slug: `wood-${id}`, title: 'Светильник', description: 'Описание', length_cm: 30, diameter_cm: null,
      offers: { [parent ? 'guide' : 'finished']: { title: 'Изделие', description: 'Проверено владельцем', priceRub: 1000, available: true, imageIndexes: [0] } },
      published_at: '2026-11-05' as string | null, updated_at: '2026-11-05', origin_kind: 'own', original_image_error: '', original_image_urls: 'file:original', original_image_files: ['original.jpg'], manual_media: [], manual_photo_selection: {} }
    cards.set(id, row); return row
  }
  const query = async (sql: string, values: any[] = []) => {
    calls.push({ sql, values })
    if (unavailable) throw new Error('database unavailable')
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
    if (sql.includes('FOR UPDATE OF i')) {
      const row = items.get(values[0]); return { rows: row?.project_id === values[1] && values[1] === 1 ? [row] : [] }
    }
    if (sql.includes('COUNT(*)')) return { rows: [{ count: [...cards.values()].filter((row) => row.content_item_id === values[0] && row.project_id === values[1]).length }] }
    if (sql.startsWith('DELETE FROM content_factory_items')) {
      if (fkRace) throw Object.assign(new Error('FK'), { code: '23503' })
      const row = items.get(values[0]); if (!row || row.project_id !== values[1]) return { rows: [] }
      items.delete(values[0]); return { rows: [{ id: row.id }] }
    }
    if (sql.startsWith('DELETE FROM catalog_cards')) {
      const row = cards.get(values[0]); if (!row || row.project_id !== values[1] || row.project_id !== 1) return { rows: [] }
      if ([...cards.values()].some((c) => c.parent_card_id === row.id)) throw Object.assign(new Error('FK'), { code: '23503' })
      cards.delete(row.id); return { rows: [{ id: row.id }] }
    }
    if (sql.includes('FROM catalog_cards c JOIN projects')) {
      return { rows: [...cards.values()].filter((row) => row.project_id === 1 && row.published_at && (!values[1] || row.id === values[1])) }
    }
    throw new Error(`Unexpected query: ${sql}`)
  }
  const pool = { query, connect: async () => ({ query, release() { releases++ } }) } as unknown as Pool
  function load(path: string) {
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports: Record<string, any> = {}
    class NextResponse extends Response { static json = Response.json }
    const modules: Record<string, unknown> = {
      '@/lib/istraart-delete': deletion, '@/lib/catalog-export': { ...catalogExport, catalogSiteProject: (value: string) => catalogExport.catalogSiteProject(value, JSON.stringify({ istraart: token })) },
      '@/lib/catalog-schema': schema, '@/lib/db': { pool }, '@/lib/crm': { resolveProjectId: async (slug: string) => slug === 'istraart' ? 1 : null },
      '@/lib/content-factory-items': {}, 'next/server': { NextResponse },
      '@/lib/catalog-manual-photo-data': {}, '@/lib/catalog-card': {},
      '@/lib/catalog-manual-media': { readManualCatalogPhoto: async () => files.get('original.jpg') },
      '@/lib/content-factory-original-images': { readOriginalImage: async () => files.get('original.jpg') },
    }
    new Function('require', 'exports', code)((key: string) => { assert.ok(key in modules, key); return modules[key] }, exports)
    return exports
  }
  return { items, cards, social, files, calls, pool, add, releases: () => releases, fkRace: () => { fkRace = true }, offline: () => { unavailable = true },
    material: load('../app/api/content-factory/items/[id]/route.ts'), card: load('../app/api/catalog/cards/[id]/route.ts'),
    exported: load('../app/api/catalog/export/route.ts'), photo: load('../app/api/catalog/export/[id]/photos/[index]/route.ts') }
}
function req(project = 'istraart', headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3140/api/target?project=${project}`, { method: 'DELETE', headers: { Authorization: 'Basic b3duZXI6cGFzcw==', Origin: 'https://admin.olnoo.com', ...headers } })
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const publicReq = () => new Request('https://admin.olnoo.com/api/catalog/export', { headers: { 'X-Olnoo-Catalog-Token': token } })

test('material deletion locks and counts, removes only the selected item, keeps Social and all photo bytes; repeat is 404', async () => {
  const h = harness(); const originalFiles = new Map(h.files); const social = structuredClone(h.social)
  assert.equal((await h.material.DELETE(req(), params('source'))).status, 200)
  assert.equal(h.items.has('source'), false); assert.equal(h.items.has('second'), true); assert.equal(h.items.has('foreign'), true)
  assert.deepEqual(h.files, originalFiles); assert.deepEqual(h.social, social)
  assert.equal((await h.material.DELETE(req(), params('source'))).status, 404)
  assert.equal(h.releases(), 2)
  const sql = h.calls.map((c) => c.sql)
  assert.ok(sql.findIndex((s) => s.includes('FOR UPDATE OF i')) < sql.findIndex((s) => s.includes('COUNT(*)')))
  assert.ok(sql.filter((s) => s.startsWith('DELETE')).every((s) => s.includes('WHERE id = $1 AND project_id = $2')))
})

test('all linked cards, including drafts and hidden guides, block material deletion and return their count', async () => {
  const h = harness(); h.add(); h.add(guideId, 'source', 1, cardId).published_at = null
  const response = await h.material.DELETE(req(), params('source'))
  assert.equal(response.status, 409); assert.equal((await response.json()).catalogCardCount, 2)
  assert.equal(h.items.size, 3); assert.equal(h.cards.size, 2)
  assert.equal(h.calls.some((c) => c.sql.startsWith('DELETE')), false)
  assert.equal(h.calls.at(-1)?.sql, 'ROLLBACK')
})

test('published card deletion removes it from the actual export and direct photo route, without changing neighbours or their relations', async () => {
  const h = harness(); h.add(); const raw = h.add(otherId)
  raw.card_kind = 'raw'; raw.offers = { raw: raw.offers.finished }
  const before = await (await h.exported.GET(publicReq())).json(); assert.equal(before.cards.length, 2)
  assert.equal(before.cards.find((card: any) => card.id === otherId).relatedCards[0].id, cardId)
  const photoParams = { params: Promise.resolve({ id: cardId, index: '0' }) }
  assert.equal((await h.photo.GET(publicReq(), photoParams)).status, 200)
  assert.equal((await h.card.DELETE(req(), params(cardId))).status, 200)
  const after = await (await h.exported.GET(publicReq())).json()
  assert.deepEqual(after.cards.map((card: any) => card.id), [otherId])
  assert.equal(after.cards[0].relatedCards, undefined)
  assert.equal(after.cards[0].offers.raw.priceRub, 1000)
  assert.equal((await h.photo.GET(publicReq(), photoParams)).status, 404)
  assert.equal((await h.card.DELETE(req(), params(cardId))).status, 404)
  assert.equal(h.items.size, 3); assert.equal(h.files.size, 2); assert.equal(h.social.length, 1)
  const liveSql = h.calls.find((c) => c.sql.startsWith('DELETE FROM catalog_cards'))!
  assert.match(liveSql.sql, /c.id = \$1 AND c.project_id = \$2/)
  assert.match(liveSql.sql, /p.slug = 'istraart'/)
  assert.match(liveSql.sql, /i.project_id = c.project_id/)
  assert.deepEqual(liveSql.values, [cardId, 1])
})

test('existing guide FK blocks parent deletion; delete guide first, without cascading or removing the source', async () => {
  const h = harness(); h.add(); h.add(guideId, 'source', 1, cardId)
  assert.equal((await h.card.DELETE(req(), params(cardId))).status, 409)
  assert.equal(h.cards.size, 2)
  assert.equal((await h.card.DELETE(req(), params(guideId))).status, 200)
  assert.equal((await h.card.DELETE(req(), params(cardId))).status, 200)
  assert.equal(h.cards.size, 0); assert.equal(h.items.has('source'), true)
})

test('destructive routes fail closed before DB access for missing auth, Bearer, foreign/missing Origin, spoofed proxy origin or foreign project', async () => {
  const h = harness()
  for (const api of [h.material, h.card]) {
    for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer site-token' }, { Origin: '' }, { Origin: 'https://evil.test', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'https' }] as Record<string, string>[]) {
      assert.equal((await api.DELETE(req('istraart', headers), params(cardId))).status, 403)
    }
    assert.equal((await api.DELETE(req('other'), params(cardId))).status, 404)
  }
  assert.equal(h.calls.length, 0)
})

test('foreign and invalid identifiers cannot delete another project or cause unscoped SQL', async () => {
  const h = harness(); h.add(otherId, 'foreign', 2)
  assert.equal((await h.material.DELETE(req(), params('foreign'))).status, 404)
  assert.equal((await h.card.DELETE(req(), params(otherId))).status, 404)
  const count = h.calls.length
  assert.equal((await h.card.DELETE(req(), params("' OR true --"))).status, 404)
  assert.equal(h.calls.length, count)
  assert.equal(h.items.has('foreign'), true); assert.equal(h.cards.has(otherId), true)
})

test('processing/claim states and FK races return safe conflicts, release transaction; database outage is not false success', async () => {
  for (const status of ['processing', 'scheduled']) {
    const h = harness(); h.items.get('source')!.status = status
    assert.equal((await h.material.DELETE(req(), params('source'))).status, 409)
    assert.equal(h.items.has('source'), true)
  }
  const claimed = harness(); claimed.items.get('source')!.en_publish_claimed = true
  assert.equal((await claimed.material.DELETE(req(), params('source'))).status, 409)
  const race = harness(); race.fkRace()
  assert.equal((await race.material.DELETE(req(), params('source'))).status, 409)
  assert.equal(race.calls.at(-1)?.sql, 'ROLLBACK'); assert.equal(race.releases(), 1)
  const offline = harness(); offline.offline()
  await assert.rejects(offline.material.DELETE(req(), params('source')), /database unavailable/)
  assert.equal(offline.releases(), 1); assert.equal(offline.items.has('source'), true)
})

test('production trusts only the configured external Origin, never an internal or forwarded origin', () => {
  const env = process.env as Record<string, string | undefined>
  const before = env.NODE_ENV
  try {
    env.NODE_ENV = 'production'
    assert.equal(deletion.istraArtDeleteAccess(req()), null)
    assert.equal(deletion.istraArtDeleteAccess(req('istraart', { Origin: 'http://localhost:3140' }))?.status, 403)
    assert.equal(deletion.istraArtDeleteAccess(req('istraart', { Origin: 'https://evil.test', 'X-Forwarded-Host': 'admin.olnoo.com' }))?.status, 403)
  } finally { if (before === undefined) delete env.NODE_ENV; else env.NODE_ENV = before }
})
