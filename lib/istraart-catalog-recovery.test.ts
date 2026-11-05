import test from 'node:test'
import * as crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'
import * as schema from './catalog-schema.ts'
import * as http from './catalog-http.ts'
import * as styles from './istraart-style.ts'
import * as store from './istraart-style-store.ts'
import * as validation from './catalog-card.ts'
import * as media from './catalog-manual-photo-data.ts'

function load(file: string, modules: Record<string, unknown>) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports: Record<string, any> = {}
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in modules, name); return modules[name] }, exports)
  return exports
}
const missingColumn = (column: string) => Object.assign(new Error(`column "${column}" does not exist (private database details)`), { code: '42703' })
const Create = () => null
const common = { './catalog-card-create': { CatalogCardCreate: Create }, 'node:crypto': crypto, '@/lib/catalog-schema': schema, '@/lib/catalog-http': http, '@/lib/istraart-style': styles, 'react/jsx-runtime': jsx }

test('only missing 0042 columns produce a safe, uncached 503; unrelated errors propagate', async () => {
  for (const column of ['istraart_style_prompt', 'manual_media', 'manual_photo_selection']) {
    const response = await schema.withCatalogSchemaGuard(async () => { throw missingColumn(column) })()
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: schema.CATALOG_MIGRATION_MESSAGE, code: 'CATALOG_MIGRATION_REQUIRED' })
  }
  for (const error of [missingColumn('card_kind'), Object.assign(new Error('database offline'), { code: '08006' }), new Error('manual_media')]) {
    await assert.rejects(schema.withCatalogSchemaGuard(async () => { throw error }), (e) => e === error)
  }
})

test('actual prompt and card GET handlers fail closed without 0042 and recover when schema is available', async () => {
  let ready = false
  const pool = { query: async (sql: string) => {
    const style = sql.includes('istraart_style_prompt')
    if (!ready) throw missingColumn(style ? 'istraart_style_prompt' : 'manual_media')
    return { rows: style ? [{ istraart_style_prompt: null }] : [] }
  } }
  const modules = { ...common, 'next/server': { NextResponse: { json: Response.json } }, '@/lib/db': { pool }, '@/lib/istraart-style-store': store, '@/lib/crm': { resolveProjectId: async () => 'project-istraart' } }
  const prompt = load('../app/api/projects/istraart-style/route.ts', modules)
  const cards = load('../app/api/catalog/cards/route.ts', { ...modules, '@/lib/catalog-card': validation, '@/lib/catalog-manual-photo-data': media })
  for (const [api, url] of [[prompt, 'projects/istraart-style'], [cards, 'catalog/cards']] as const) {
    const response = await api.GET(new Request(`https://admin.test/api/${url}?project=istraart`))
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'CATALOG_MIGRATION_REQUIRED')
  }
  ready = true
  assert.equal((await (await prompt.GET(new Request('https://admin.test/api/projects/istraart-style?project=istraart'))).json()).prompt, styles.ISTRAART_STYLE_DEFAULT)
  assert.deepEqual(await (await cards.GET(new Request('https://admin.test/api/catalog/cards?project=istraart'))).json(), [])
  assert.equal((await prompt.GET(new Request('https://admin.test/api/projects/istraart-style?project=other'))).status, 404)
})

function view(file: string, name: string, state: any[], extra: Record<string, unknown> = {}) {
  let cursor = 0
  const component = load(file, { ...common, ...extra, react: { useEffect() {}, useRef(initial: any) { return { current: initial } }, useState(initial: any) { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial; return [state[slot], (next: any) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }] } } })[name]
  return (props = {}) => { cursor = 0; return component(props) }
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
const text = (tree: any): string => tree == null || typeof tree === 'boolean' ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.props?.children)
const button = (tree: any, label: string) => nodes(tree).find((node) => node.type === 'button' && text(node) === label)

test('prompt load failure keeps copy/save disabled with diagnostics; explicit retry loads the real prompt', async () => {
  const before = globalThis.fetch
  try {
    let ready = false
    globalThis.fetch = async () => ready ? Response.json({ prompt: 'Стиль владельца' }) : Response.json({ error: schema.CATALOG_MIGRATION_MESSAGE }, { status: 503 })
    for (const name of ['IstraArtChatGptPrompt', 'IstraArtStylePanel']) {
      const copy = name === 'IstraArtChatGptPrompt'
      const state = copy ? [null, 'Не удалось загрузить промпт IstraArt.', false] : ['', '', false, 'Не удалось загрузить промпт.']
      const render = view('../components/sections/istraart-style-panel.tsx', name, state)
      const props = copy ? { task: 'finished', card: { title: 'Коряга', description: '', lengthCm: null, diameterCm: null, offers: {} }, originalText: '' } : {}
      const label = copy ? 'Скопировать промпт для ChatGPT' : 'Сохранить промпт'
      assert.equal(button(render(props), label).props.disabled, true)
      ready = false
      await button(render(props), 'Повторить загрузку промпта').props.onClick()
      assert.ok(text(render(props)).includes(schema.CATALOG_MIGRATION_MESSAGE))
      assert.equal(button(render(props), label).props.disabled, true)
      ready = true
      await button(render(props), 'Повторить загрузку промпта').props.onClick()
      const tree = render(props)
      assert.equal(button(tree, 'Повторить загрузку промпта'), undefined)
      if (copy) assert.equal(button(tree, label).props.disabled, false)
      else assert.equal(nodes(tree).find((n) => n.type === 'textarea').props.disabled, false)
      assert.ok(nodes(tree).some((n) => n.type === 'textarea' && n.props.value.startsWith('Стиль владельца')))
    }
  } finally { globalThis.fetch = before }
})

test('failed catalog GET shows retry instead of blank-field errors; retry restores editing without relaxing publish checks', async () => {
  const before = globalThis.fetch
  try {
    let ready = false, requests = 0
    const state = [true, null, [], 'finished', null, false, false, 'finished', { title: '', slug: '', description: '', lengthCm: null, diameterCm: null, offers: {} }, {}, false, false, false, false, 'Load failed']
    const render = view('../components/sections/catalog-card-editor.tsx', 'CatalogCardEditor', state, {
      '@/lib/catalog-card': validation, '@/lib/catalog-manual-photo-data': media,
      '@/components/sections/istraart-style-panel': { IstraArtChatGptPrompt: () => null }, '@/components/sections/catalog-manual-upload': { CatalogManualUpload: () => null },
    })
    globalThis.fetch = async (_url, init) => { requests++; assert.equal(init?.method, undefined); return ready ? Response.json([]) : Response.json({ error: schema.CATALOG_MIGRATION_MESSAGE }, { status: 503 }) }
    const props = { project: 'istraart', item: { id: 'item', originalText: 'Деревянная заготовка', originalImageFiles: [] } }
    let tree = render(props)
    assert.equal(nodes(tree).some((n) => n.type === 'input'), false)
    assert.equal(nodes(tree).find((n) => n.type === Create).props.disabled, true)
    await button(tree, 'Повторить загрузку карточек').props.onClick()
    tree = render(props)
    assert.ok(text(tree).includes(schema.CATALOG_MIGRATION_MESSAGE))
    assert.equal(nodes(tree).some((n) => n.type === 'input'), false)
    ready = true
    await button(tree, 'Повторить загрузку карточек').props.onClick()
    tree = render(props)
    assert.equal(nodes(tree).find((n) => n.type === Create).props.disabled, false)
    assert.equal(button(tree, 'Опубликовать на сайте').props.disabled, true)
    assert.ok(nodes(tree).some((n) => n.type === 'input' && n.props.value === 'Деревянная заготовка'))
    assert.equal(nodes(tree).some((n) => n.props?.['aria-invalid'] === true), false)
    nodes(tree).find((n) => n.type === 'input' && n.props.value === 'Деревянная заготовка').props.onChange({ target: { value: '' } })
    await button(render(props), 'Сохранить').props.onClick()
    assert.equal(requests, 2, 'invalid draft must not be sent')
    assert.ok(nodes(render(props)).some((n) => n.props?.['aria-invalid'] === true), 'validation remains on explicit save')
  } finally { globalThis.fetch = before }
})

test('HTTP diagnostics distinguish auth errors, safe API diagnostics and non-JSON proxy failures', async () => {
  assert.match(await http.catalogResponseError(new Response('', { status: 401 }), 'fallback'), /авторизацию/)
  assert.match(await http.catalogResponseError(new Response('', { status: 403 }), 'fallback'), /авторизацию/)
  assert.equal(await http.catalogResponseError(new Response('<html>Bad gateway</html>', { status: 502 }), 'fallback'), 'fallback')
})
