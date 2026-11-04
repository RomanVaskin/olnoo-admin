import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'
import * as styles from './istraart-style.ts'
import * as store from './istraart-style-store.ts'
import * as mediaData from './catalog-manual-photo-data.ts'
import { catalogSiteProject, catalogPhotoSelection } from './catalog-export.ts'
import { CatalogMediaError } from './catalog-manual-media.ts'
const cardId = '00000000-0000-4000-8000-000000000001', imageId = '00000000-0000-4000-8000-000000000002', sourceId = '00000000-0000-4000-8000-000000000003'
const asset = { id: imageId, filename: `${imageId}.png`, slot: 0, kind: 'ai', origin: 'upload', mimeType: 'image/png', createdAt: '2026-11-04T00:00:00Z' }
function load(file: string, modules: Record<string, unknown>) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports: Record<string, any> = {}
  class NextResponse extends Response { static json = Response.json }
  new Function('require', 'exports', compiled)((name: string) => name === 'next/server' ? { NextResponse } : (assert.ok(name in modules, name), modules[name]), exports)
  return exports
}
const params = { params: Promise.resolve({ id: cardId }) }

test('style settings handler saves exactly one IstraArt prompt and rejects another project, invalid input and cross-origin writes', async () => {
  let saved: string | null = null, queries = 0
  const api = load('../app/api/projects/istraart-style/route.ts', {
    '@/lib/istraart-style': styles, '@/lib/istraart-style-store': store,
    '@/lib/db': { pool: { query: async (sql: string, args: unknown[] = []) => { queries++; assert.match(sql, /slug='istraart' AND archived_at IS NULL/); if (sql.startsWith('UPDATE')) saved = String(args[0]); return { rows: [{ istraart_style_prompt: saved }] } } } },
  })
  const request = (project = 'istraart', prompt?: string, origin?: string) => new Request(`https://admin.test/api/projects/istraart-style?project=${project}`, prompt === undefined ? {} : { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ prompt }) })
  assert.equal((await api.GET(request('other'))).status, 404)
  assert.equal(queries, 0)
  assert.equal((await (await api.GET(request())).json()).prompt, styles.ISTRAART_STYLE_DEFAULT)
  assert.equal((await api.PUT(request('istraart', 'Правка владельца', 'https://evil.test'))).status, 403)
  assert.equal((await api.PUT(request('other', 'Wrong project'))).status, 404)
  assert.equal((await api.PUT(request('istraart', ' '))).status, 422)
  const good = await api.PUT(request('istraart', '  Правка владельца  ', 'https://admin.test'))
  assert.equal(good.status, 200)
  assert.equal((await good.json()).prompt, 'Правка владельца')
  assert.equal((await (await api.GET(request())).json()).prompt, 'Правка владельца')
})

test('copy button writes the current card context and edited style to clipboard; failure offers visible text', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    let written = '', fail = false
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value: string) => { if (fail) throw new Error('denied'); written = value } } } })
    let hook = 0; const messages: string[] = []
    const client = load('../components/sections/istraart-style-panel.tsx', {
      '@/lib/istraart-style': styles, 'react/jsx-runtime': jsx,
      react: { useEffect() {}, useState: () => ++hook === 1 ? ['Мой сохранённый стиль', () => {}] : ['', (message: string) => messages.push(message)] },
    })
    const tree = client.IstraArtChatGptPrompt({ task: 'finished', card: { title: 'Исправленное название', description: 'Описание владельца', lengthCm: 56, diameterCm: null, offers: {} }, originalText: 'Исходные сведения' })
    const button = tree.props.children.find((c: any) => c?.type === 'button')
    await button.props.onClick()
    assert.ok(written.startsWith('Мой сохранённый стиль'))
    assert.ok(written.includes('Исправленное название'))
    assert.ok(written.includes('56 см'))
    assert.ok(written.includes('ГОТОВОЕ ИЗДЕЛИЕ'))
    assert.ok(messages.at(-1)?.includes('скопирован'))
    fail = true; await button.props.onClick()
    assert.ok(messages.at(-1)?.includes('Выделите и скопируйте'))
  } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete (globalThis as any).navigator }
})

test('upload endpoint and private preview scope card/project IDs, require an explicit photo kind and preserve the original intake route', async () => {
  let uploads = 0, imports = 0, reads = 0
  const modules = {
    '@/lib/crm': { resolveProjectId: async () => 7 },
    '@/lib/catalog-manual-photo-data': mediaData,
    '@/lib/db': { pool: { query: async (sql: string, args: unknown[]) => { assert.match(sql, /c.project_id=\$2 AND i.origin_kind='own'/); assert.equal(args[1], 7); return { rows: args[0] === cardId ? [{ manual_media: [asset] }] : [] } } } },
    '@/lib/catalog-manual-media': { CatalogMediaError, CATALOG_UPLOAD_MAX: 10 * 1024 * 1024,
      attachManualCatalogPhoto: async (_db: unknown, project: number, id: string, bytes: Buffer, kind: string, slot: number, origin: string) => { uploads++; assert.equal(project, 7); assert.equal(id, cardId); assert.equal(bytes.toString(), 'fixture bytes'); assert.equal(kind, 'ai'); assert.equal(slot, 0); assert.equal(origin, 'upload'); return [asset] },
      importTelegramCatalogPhoto: async (_db: unknown, project: number, id: string, source: string, index: number, kind: string, slot: number) => { assert.equal(project, 7); assert.equal(id, cardId); if (source !== sourceId) throw new CatalogMediaError('Фото не найдено.', 404); imports++; assert.equal(index, 0); assert.equal(kind, 'real'); assert.equal(slot, 1); return [asset] },
      readManualCatalogPhoto: async (project: number, id: string, filename: string) => { reads++; assert.equal(project, 7); assert.equal(id, cardId); assert.equal(filename, asset.filename); return Buffer.from('private image') },
    },
  }
  const api = load('../app/api/catalog/cards/[id]/media/route.ts', modules)
  const preview = load('../app/api/catalog/cards/[id]/media/[photo]/route.ts', modules)
  const url = (project = 'istraart') => `https://admin.test/api/catalog/cards/${cardId}/media?project=${project}`
  const form = (kind?: string) => { const data = new FormData(); data.set('file', new File(['fixture bytes'], 'upload.png', { type: 'image/png' })); if (kind) data.set('kind', kind); data.set('slot', '0'); return data }
  assert.equal((await api.POST(new Request(url('other'), { method: 'POST', body: form('ai') }), params)).status, 404)
  assert.equal((await api.POST(new Request(url(), { method: 'POST', headers: { Origin: 'https://evil.test' }, body: form('ai') }), params)).status, 403)
  assert.equal((await api.POST(new Request(url(), { method: 'POST', body: form() }), params)).status, 422)
  assert.equal(uploads, 0)
  assert.equal((await api.POST(new Request(url(), { method: 'POST', body: form('ai') }), params)).status, 201)
  const telegram = (itemId: string) => new Request(url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, index: 0, kind: 'real', slot: 1 }) })
  assert.equal((await api.POST(telegram(sourceId), params)).status, 201)
  assert.equal((await api.POST(telegram(imageId), params)).status, 404)
  assert.equal(imports, 1)
  const image = await preview.GET(new Request(url()), { params: Promise.resolve({ id: cardId, photo: imageId }) })
  assert.equal(image.headers.get('Cache-Control'), 'no-store')
  assert.equal(await image.text(), 'private image')
  for (const [id, photo, project] of [[imageId, imageId, 'istraart'], [cardId, sourceId, 'istraart'], [cardId, imageId, 'other'], ['../secret', imageId, 'istraart']]) assert.equal((await preview.GET(new Request(url(project)), { params: Promise.resolve({ id, photo }) })).status, 404)
  assert.equal(reads, 1)
})


test('public file relay keeps token/publication/index guards when selecting a manually uploaded file', async () => {
  const previous = process.env.CATALOG_SITE_TOKENS
  process.env.CATALOG_SITE_TOKENS = JSON.stringify({ istraart: 'a'.repeat(40), other: 'b'.repeat(40) })
  try {
    let published = true, reads = 0
    const row = () => ({ id: cardId, project_id: 7, item_id: sourceId, slug: 'product', title: 'Изделие', description: '', length_cm: null, diameter_cm: null, card_kind: 'finished', offers: { finished: { title: 'Изделие', description: 'Описание', priceRub: 1500, available: true, imageIndexes: [0] } }, published_at: published ? '2026-11-04' : null, updated_at: '2026-11-04', origin_kind: 'own', original_image_files: [], original_image_urls: '', original_image_error: '', manual_media: [asset], manual_photo_selection: { 0: imageId } })
    const api = load('../app/api/catalog/export/[id]/photos/[index]/route.ts', {
      '@/lib/db': { pool: {} },
      '@/lib/catalog-export': { catalogSiteProject, catalogPhotoSelection, publishedCatalogRows: async (_pool: unknown, project: string, id: string) => project === 'istraart' && id === cardId ? [row()] : [] },
      '@/lib/catalog-manual-media': { readManualCatalogPhoto: async (project: number, id: string, filename: string) => { assert.equal(project, 7); assert.equal(id, cardId); assert.equal(filename, asset.filename); reads++; return Buffer.from('approved image') } },
      '@/lib/content-factory-original-images': { readOriginalImage: () => { throw new Error('Wrong file selected') } },
    })
    const get = (token?: string, index = '0') => api.GET(new Request('https://admin.test/api/catalog/export/x/photos/0?project=other', { headers: token ? { 'X-Olnoo-Catalog-Token': token } : {} }), { params: Promise.resolve({ id: cardId, index }) })
    assert.equal((await get()).status, 403)
    assert.equal((await get('b'.repeat(40))).status, 404)
    assert.equal((await get('a'.repeat(40), '1')).status, 404)
    assert.equal(reads, 0)
    const image = await get('a'.repeat(40))
    assert.equal(await image.text(), 'approved image')
    assert.equal(image.headers.get('Content-Type'), 'image/png')
    assert.equal(image.headers.get('Cache-Control'), 'no-store')
    published = false
    assert.equal((await get('a'.repeat(40))).status, 404)
    assert.equal(reads, 1)
  } finally { if (previous === undefined) delete process.env.CATALOG_SITE_TOKENS; else process.env.CATALOG_SITE_TOKENS = previous }
})
