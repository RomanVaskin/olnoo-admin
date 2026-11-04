import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsx from 'react/jsx-runtime'
import * as photos from './catalog-photo-data.ts'
import { catalogPhotoSelection, catalogSiteProject } from './catalog-export.ts'
import { CatalogPhotoError } from './catalog-photo-processing.ts'
const item = '00000000-0000-4000-8000-000000000001', version = '00000000-0000-4000-8000-000000000002'
const filename = '00000000-0000-4000-8000-000000000003.png'
const record = { id: version, filename: `${version}.png`, originalFilename: filename, originalIndex: 0, model: 'gemini-3.1-flash-image', provider: 'gemini', createdAt: '2026-11-04T00:00:00Z' }
function load(file: string, modules: Record<string, unknown>) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports: Record<string, any> = {}
  class NextResponse extends Response { static json = Response.json }
  new Function('require', 'exports', compiled)((name: string) => name === 'next/server' ? { NextResponse } : (assert.ok(name in modules, name), modules[name]), exports)
  return exports
}

test('processed photo API is project/source/version scoped, safe to preview and does not return paths or secrets', async () => {
  let generated = 0, read = 0, fail = false
  const modules = {
    '@/lib/crm': { resolveProjectId: async () => 7 },
    '@/lib/db': { pool: { query: async (sql: string, args: unknown[]) => {
      assert.match(sql, /project_id=\$2 AND origin_kind='own'/)
      assert.equal(args[1], 7)
      return { rows: args[0] === item ? [{ original_image_files: [filename], processed_image_versions: [record] }] : [] }
    } } },
    '@/lib/catalog-photo-data': photos,
    '@/lib/catalog-photo-processing': { CatalogPhotoError, processCatalogPhoto: async () => { generated++; if (fail) throw new Error('SYNTHETIC_SECRET never return upstream detail'); return record }, readProcessedCatalogPhoto: async (project: number, id: string, file: string) => { assert.equal(project, 7); assert.equal(id, item); assert.equal(file, record.filename); read++; return Buffer.from('PNG fixture') } },
  }
  const api = load('../app/api/catalog/photo-processing/[id]/route.ts', modules)
  const preview = load('../app/api/catalog/photo-processing/[id]/[version]/route.ts', modules)
  const params = { params: Promise.resolve({ id: item }) }
  const request = (project = 'istraart', body?: unknown, origin?: string) => new Request(`https://admin.test/api/catalog/photo-processing/${item}?project=${project}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) } : {})
  const listing = await api.GET(request(), params)
  assert.equal(listing.headers.get('Cache-Control'), 'no-store')
  const json = await listing.json()
  assert.deepEqual(Object.keys(json[0]).sort(), ['createdAt', 'id', 'model', 'originalIndex'])
  assert.equal(JSON.stringify(json).includes(filename), false)
  assert.equal(generated, 0, 'opening a preview must not call AI')
  assert.equal((await api.GET(request('other'), params)).status, 404)
  assert.equal((await api.GET(request(), { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000099' }) })).status, 404)
  assert.equal((await api.POST(request('other', { originalIndex: 0 }), params)).status, 404)
  assert.equal((await api.POST(request('istraart', { originalIndex: 0 }, 'https://attacker.test'), params)).status, 403)
  assert.equal((await api.POST(request('istraart', { originalIndex: 20 }), params)).status, 400)
  assert.equal(generated, 0)
  const good = await api.POST(request('istraart', { originalIndex: 0 }, 'https://admin.test'), params)
  assert.equal(good.status, 201)
  assert.deepEqual(Object.keys(await good.json()).sort(), ['createdAt', 'id', 'model', 'originalIndex'])
  fail = true
  const error = await api.POST(request('istraart', { originalIndex: 0 }), params)
  assert.equal(error.status, 500)
  assert.equal((await error.text()).includes('SYNTHETIC_SECRET'), false)
  assert.equal((await api.GET(request(), params)).status, 200, 'old versions remain available after failure')
  const image = await preview.GET(request(), { params: Promise.resolve({ id: item, version }) })
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('Content-Type'), 'image/png')
  assert.equal(read, 1)
  assert.equal((await preview.GET(request('other'), { params: Promise.resolve({ id: item, version }) })).status, 404)
  assert.equal((await preview.GET(request(), { params: Promise.resolve({ id: item, version: '00000000-0000-4000-8000-000000000099' }) })).status, 404)
  assert.equal(read, 1)
})

test('public photo export serves only the selected processed file of a published same-project card', async () => {
  const previous = process.env.CATALOG_SITE_TOKENS
  process.env.CATALOG_SITE_TOKENS = JSON.stringify({ istraart: 'a'.repeat(40), other: 'b'.repeat(40) })
  try {
    let published = true, history = [record], processedReads = 0
    const row = () => ({ id: item, slug: 'raw', title: 'Материал', description: '', length_cm: null, diameter_cm: null, card_kind: 'raw', offers: { raw: { title: 'Материал', description: 'Описание', priceRub: 100, available: true, imageIndexes: [0] } }, published_at: published ? '2026-11-04' : null, updated_at: '2026-11-04', origin_kind: 'own', project_id: 7, item_id: item, original_image_files: [filename], original_image_urls: 'file:x', original_image_error: '', photo_versions: { 0: version }, processed_image_versions: history })
    const api = load('../app/api/catalog/export/[id]/photos/[index]/route.ts', {
      '@/lib/db': { pool: {} },
      '@/lib/catalog-export': { catalogSiteProject, catalogPhotoSelection, publishedCatalogRows: async (_db: unknown, project: string, id: string) => project === 'istraart' && id === item ? [row()] : [] },
      '@/lib/catalog-photo-processing': { readProcessedCatalogPhoto: async (_project: number, _item: string, file: string) => { assert.equal(file, `${version}.png`); processedReads++; return Buffer.from('processed') } },
      '@/lib/content-factory-original-images': { readOriginalImage: async () => { throw new Error('Must serve the chosen version') } },
    })
    const get = (key?: string, index = '0') => api.GET(new Request('https://admin.test/api/catalog/export/x/photos/0?project=other', { headers: key ? { 'X-Olnoo-Catalog-Token': key } : {} }), { params: Promise.resolve({ id: item, index }) })
    assert.equal((await get()).status, 403)
    assert.equal((await get('b'.repeat(40))).status, 404)
    assert.equal((await get('a'.repeat(40), '1')).status, 404)
    const response = await get('a'.repeat(40))
    assert.equal(await response.text(), 'processed')
    assert.equal(response.headers.get('X-Olnoo-Catalog-Project'), 'istraart')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    published = false
    assert.equal((await get('a'.repeat(40))).status, 404)
    published = true; history = []
    assert.equal((await get('a'.repeat(40))).status, 404)
    assert.equal(processedReads, 1)
  } finally { if (previous === undefined) delete process.env.CATALOG_SITE_TOKENS; else process.env.CATALOG_SITE_TOKENS = previous }
})


test('comparison UI keeps the original and prior processed result visible while showing a processing error', () => {
  let state = 0
  const states = [[{ id: version, originalIndex: 0, model: record.model, createdAt: record.createdAt }], {}, false, 'Обработка не удалась. Оригинал сохранён.']
  const { CatalogPhotoProcessing } = load('../components/sections/catalog-photo-processing.tsx', {
    react: { useState: () => [states[state++], () => {}], useEffect: () => {}, useRef: () => ({ current: true }) },
    'react/jsx-runtime': jsx,
  })
  const html = renderToStaticMarkup(createElement(CatalogPhotoProcessing, { project: 'istraart', itemId: item, photoCount: 1, disabled: false, onVersions: () => {} }))
  assert.ok(html.includes(`/api/content-factory/items/${item}/original-images/0?project=istraart`))
  assert.ok(html.includes(`/api/catalog/photo-processing/${item}/${version}?project=istraart`))
  assert.ok(html.includes('Обработка не удалась'))
  assert.ok(html.includes('Обработать ещё раз'))
  for (const secret of ['OLNOO_ROUTER_TOKEN', 'x-api-key', 'originalFilename', filename]) assert.equal(html.includes(secret), false)
})
