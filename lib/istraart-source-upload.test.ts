import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { CatalogMediaError } from './catalog-manual-media.ts'
import { catalogUuid } from './catalog-manual-photo-data.ts'
const id = '00000000-0000-4000-8000-000000000001'
function harness(patch: Record<string, unknown> = {}, published = false, fail = '') {
  let row: any = { id, status: 'new', origin_kind: 'own', original_text: 'Telegram original !', original_image_files: ['original.png'], original_image_urls: 'telegram-file:original', original_image_error: '', social_post_id: null, en_social_post_id: null, en_publish_claimed: false, ...patch }
  let snapshot: any, committed = false, released = 0, syncs = 0
  const writes: Buffer[] = [], removed: string[] = [], sqls: string[] = []
  const query = async (sql: string, args: any[] = []) => {
    sqls.push(sql)
    if (sql === 'BEGIN') { snapshot = structuredClone(row); return { rows: [] } }
    if (sql === 'COMMIT') { committed = true; if (fail === 'commit') throw new Error('uncertain commit'); return { rows: [] } }
    if (sql === 'ROLLBACK') { if (!committed) row = snapshot; return { rows: [] } }
    if (sql.includes('FROM catalog_cards')) { assert.match(sql, /FOR UPDATE/); return { rows: published ? [{ published_at: '2026-11-05' }] : [] } }
    if (sql.includes('SELECT i.*')) { assert.match(sql, /p.slug='istraart'[\s\S]*p.archived_at IS NULL FOR UPDATE OF i/); return { rows: row.origin_kind === 'own' ? [row] : [] } }
    assert.match(sql, /^UPDATE content_factory_items/)
    assert.equal(sql.includes('original_text='), false); assert.equal(sql.includes('generated_text='), false)
    if (fail === 'update') throw new Error('save failed')
    row.original_image_files = [...row.original_image_files, args[0]]
    row.original_image_urls += ',' + args[1]
    return { rows: [{ id }] }
  }
  const modules: Record<string, any> = {
    'pg': {}, 'next/server': { NextResponse: { json: Response.json } }, 'node:fs/promises': { unlink: async (p: string) => { removed.push(p) } },
    '@/lib/db': { pool: { connect: async () => ({ query, release() { released++ } }) } },
    '@/lib/crm': { resolveProjectId: async (p: string) => p === 'istraart' ? 1 : 2 },
    '@/lib/content-factory-items': { getItem: async () => ({ id, originalText: row.original_text, originalImageFiles: row.original_image_files, originalImageUrls: row.original_image_urls.split(','), processingMode: row.processing_mode ?? 'ai', status: row.status, sourceId: 'source', originalUrl: '', externalId: '1' }) },
    '@/lib/catalog-manual-photo-data': { catalogUuid },
    '@/lib/catalog-manual-media': { CATALOG_UPLOAD_MAX: 10 * 1024 * 1024, CatalogMediaError, inspectCatalogUpload: async (bytes: Buffer) => { if (bytes.toString() === 'corrupt') throw new CatalogMediaError('Invalid image') } },
    '@/lib/content-factory-original-images': { syncOriginalImages: async () => { syncs++ }, writeOriginalImage: async (project: number, item: string, bytes: Buffer) => { assert.equal(project, 1); assert.equal(item, id); writes.push(bytes); return 'appended.png' }, originalImagePath: () => '/tmp/test-original/appended.png' },
    '@/lib/content-factory-sources': { getSource: async () => null }, '@/lib/content-factory-telegram-source': {},
  }
  const exports: any = {}
  const code = ts.transpileModule(readFileSync(new URL('../app/api/content-factory/items/[id]/original-images/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require','exports',code)((key: string) => { assert.ok(key in modules, key); return modules[key] }, exports)
  return { post: exports.POST, writes, removed, sqls, row: () => row, released: () => released, syncs: () => syncs }
}
const request = (project = 'istraart', origin = 'https://admin.olnoo.com', text: string | Buffer = 'unchanged image bytes') => {
  const form = new FormData(); form.set('file', new File([text], 'photo.png', { type: 'image/png' }))
  return new Request(`http://localhost:3140/api/content-factory/items/${id}/original-images?project=${project}`, { method: 'POST', headers: { Origin: origin }, body: form })
}
const params = { params: Promise.resolve({ id }) }

test('source upload appends unchanged bytes to existing original storage, preserving text/files and returning the material', async () => {
  const h = harness()
  const response = await h.post(request(), params)
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store')
  const item = await response.json()
  assert.equal(item.originalText, 'Telegram original !')
  assert.deepEqual(item.originalImageFiles, ['original.png','appended.png'])
  assert.deepEqual(item.originalImageUrls, ['telegram-file:original','upload:appended.png'])
  assert.equal(h.writes[0].toString(), 'unchanged image bytes')
  assert.equal(h.removed.length, 0); assert.equal(h.released(), 1)
})

test('source upload rejects foreign origin/project, prepared/linked/non-own material, published cards and incomplete originals', async () => {
  for (const [patch, published, status] of [[{ status: 'ready' },false,409], [{ status: 'processing' },false,409], [{ status: 'failed', generated_text: 'prepared' },false,409], [{ social_post_id: 'post' },false,409], [{ en_publish_claimed: true },false,409], [{ origin_kind: 'source' },false,404], [{},true,409], [{ original_image_error: 'incomplete' },false,409], [{ original_image_urls: 'one,two' },false,409]] as const) {
    const h = harness(patch, published)
    assert.equal((await h.post(request(), params)).status, status)
    assert.equal(h.writes.length, 0)
    assert.deepEqual(h.row().original_image_files, ['original.png'])
  }
  const other = harness()
  assert.equal((await other.post(request('other'), params)).status, 404)
  assert.equal((await other.post(request('istraart','https://evil.test'), params)).status, 403)
  assert.equal(other.writes.length, 0); assert.equal(other.sqls.length, 0)
})

test('source upload bounds input and preserves old files on corrupt input, write failure and uncertain commit', async () => {
  const invalid = harness()
  assert.equal((await invalid.post(request('istraart', 'https://admin.olnoo.com', 'corrupt'), params)).status, 422)
  assert.equal(invalid.writes.length, 0)
  const oversized = new Request(`http://localhost:3140/api/content-factory/items/${id}/original-images?project=istraart`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(12 * 1024 * 1024)); c.close() } }), duplex: 'half' } as any)
  assert.equal((await invalid.post(oversized, params)).status, 422)
  const failed = harness({}, false, 'update')
  assert.equal((await failed.post(request(), params)).status, 500)
  assert.deepEqual(failed.row().original_image_files, ['original.png'])
  assert.equal(failed.removed.length, 1, 'remove only the unreferenced new file')
  const uncertain = harness({}, false, 'commit')
  const response = await uncertain.post(request(), params)
  assert.equal(response.status, 503); assert.match((await response.json()).error, /проверьте фотографии/)
  assert.equal(uncertain.removed.length, 0, 'never delete a possibly committed new file')
  assert.deepEqual(uncertain.row().original_image_files, ['original.png','appended.png'])
})


test('the existing bodyless partner-copy retry remains available for other projects', async () => {
  const h = harness({ origin_kind: 'source', processing_mode: 'copy' })
  const response = await h.post(new Request(`https://admin.test/api/content-factory/items/${id}/original-images?project=other`, { method: 'POST' }), params)
  assert.equal(response.status, 200); assert.equal(h.syncs(), 1)
  assert.equal(h.writes.length, 0); assert.equal(h.sqls.length, 0)
})
