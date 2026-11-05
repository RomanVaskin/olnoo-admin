import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'
import * as validation from './catalog-card.ts'
import * as media from './catalog-manual-photo-data.ts'
import * as http from './catalog-http.ts'
import { ru } from './i18n/messages/ru.ts'

function view(file: string, name: string, state: any[], modules: Record<string, unknown>) {
  let cursor = 0, refCursor = 0
  const refs: any[] = []
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports: Record<string, any> = {}
  const hooks = {
    useEffect() {},
    useRef(initial: any) { const slot = refCursor++; return refs[slot] ??= { current: initial } },
    useState(initial: any) { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial; return [state[slot], (next: any) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }] },
  }
  const dependencies = { ...modules, react: hooks, 'react/jsx-runtime': jsx }
  new Function('require', 'exports', compiled + (name === 'ItemDetail' ? '\nexports.ItemDetail = ItemDetail;' : ''))((key: string) => { assert.ok(key in dependencies, key); return dependencies[key as keyof typeof dependencies] }, exports)
  return Object.assign((props: any) => { cursor = 0; refCursor = 0; return exports[name](props) }, { refs })
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
function text(tree: any): string { return tree == null || typeof tree === 'boolean' ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children) }
const button = (tree: any, label: string) => nodes(tree).find((n) => n.type === 'button' && text(n) === label)
const control = (tree: any, label: string) => nodes(nodes(tree).find((n) => n.type === 'label' && text(n).startsWith(label))).find((n) => ['input', 'textarea', 'select'].includes(n.type))
const item = { id: '00000000-0000-4000-8000-000000000001', originalText: 'Коряга', originalImageFiles: ['original.png'], originalImageUrls: ['file:original'] }
const photoId = '00000000-0000-4000-8000-000000000002'
const aiPhoto = { id: photoId, slot: 0, filename: `${photoId}.png`, kind: 'ai', origin: 'upload', mimeType: 'image/png', createdAt: '2026-11-05T00:00:00Z' }
function row(kind = 'finished', id = 'card') { return { id, content_item_id: item.id, card_kind: kind, parent_card_id: kind === 'guide' ? 'card' : null, title: 'Название карточки', slug: `card-${kind}`, description: 'Отдельное описание карточки', length_cm: 50, diameter_cm: null, offers: { [kind]: { title: 'Название предложения', description: 'Описание предложения', priceRub: 1200, available: true, imageIndexes: [0] } }, manual_media: [aiPhoto], manual_photo_selection: {}, published_at: null as string | null } }
const ManualUpload = () => null, ChatGptPrompt = () => null, CardCreate = () => null
function editor(current = row(), cards = [current]) {
  const state: any[] = [true, current, cards, 'finished', null, false, false, 'finished', { title: current.title, slug: current.slug, description: current.description, lengthCm: current.length_cm, diameterCm: current.diameter_cm, offers: current.offers, manualPhotoSelection: current.manual_photo_selection }, {}, true, false, false, false, '']
  const render = view('../components/sections/catalog-card-editor.tsx', 'CatalogCardEditor', state, {
    './catalog-card-create': { CatalogCardCreate: CardCreate }, '@/lib/catalog-card': validation, '@/lib/catalog-manual-photo-data': media, '@/lib/catalog-http': http,
    '@/components/sections/catalog-manual-upload': { CatalogManualUpload: ManualUpload }, '@/components/sections/istraart-style-panel': { IstraArtChatGptPrompt: ChatGptPrompt },
  })
  return { state, render: () => render({ project: 'istraart', item, social: jsx.jsx('div', { children: 'Независимые соцсети' }) }) }
}

test('catalog retains one save and gallery with collapsed extras and independent card/offer values', () => {
  const { state, render } = editor()
  const tree = render()
  for (const label of ['Товар', 'Фотографии', 'ИИ-помощник', 'Публикация']) assert.ok(text(tree).includes(label))
  assert.equal(nodes(tree).filter((n) => n.type === 'button' && text(n) === 'Сохранить карточку').length, 1)
  assert.equal(nodes(tree).filter((n) => n.type === 'img').length, 1)
  for (const label of ['Размеры и дополнительные данные', 'ИИ-помощник']) {
    const details = nodes(tree).find((n) => n.type === 'details' && nodes(n).some((c) => c.type === 'summary' && text(c) === label))
    assert.ok(details); assert.equal(!!details.props.open, false)
  }
  assert.equal(nodes(tree).some((n) => n.props?.['aria-invalid']), false)
  control(tree, 'Название').props.onChange({ target: { value: 'Новое имя карточки' } })
  control(render(), 'Описание').props.onChange({ target: { value: 'Новое описание предложения' } })
  assert.equal(state[8].title, 'Новое имя карточки')
  assert.equal(state[8].offers.finished.title, 'Название предложения')
  assert.equal(state[8].description, 'Отдельное описание карточки')
  assert.equal(state[8].offers.finished.description, 'Новое описание предложения')
  assert.equal(button(render(), 'Опубликовать на сайте').props.disabled, true, 'dirty card requires save')
})

test('switching raw/finished/linked guide preserves the source and separate drafts', () => {
  const finished = row(), raw = row('raw', 'raw'), guide = row('guide', 'guide')
  const { state, render } = editor(finished, [finished, raw, guide])
  control(render(), 'Карточки этого материала').props.onChange({ target: { value: 'raw' } })
  assert.equal(state[1].id, 'raw'); assert.equal(state[8].offers.raw.priceRub, 1200)
  assert.equal(nodes(render()).find((n) => n.type === ChatGptPrompt).props.task, 'raw')
  control(render(), 'Карточки этого материала').props.onChange({ target: { value: 'guide' } })
  assert.ok(text(render()).includes('Изделие: Название карточки'))
  assert.equal(nodes(render()).find((n) => n.type === ChatGptPrompt).props.task, 'guide')
  control(render(), 'Карточки этого материала').props.onChange({ target: { value: 'card' } })
  assert.equal(state[2].length, 3)
  assert.equal(state[1].id, 'card')
  assert.equal(nodes(render()).find((n) => n.type === ChatGptPrompt).props.task, 'finished')
})

test('photo selection keeps originals and variants; legacy cards share one gallery with independent offer selections', () => {
  const { state, render } = editor()
  assert.equal(control(render(), 'В карточке').props.checked, true)
  const file = nodes(render()).find((n) => n.props?.['aria-label'] === 'Файл для фото 1')
  file.props.onChange({ target: { value: photoId } })
  assert.equal(state[8].manualPhotoSelection['0'], photoId)
  assert.equal(text(render()).includes('ИИ-визуализация'), false)
  assert.equal(state[1].manual_media[0].kind, 'ai')
  assert.match(nodes(render()).find((n) => n.type === 'img').props.src, /\/media\//)
  assert.deepEqual(item.originalImageFiles, ['original.png'])
  file.props.onChange({ target: { value: '' } })
  assert.match(nodes(render()).find((n) => n.type === 'img').props.src, /original-images\/0/)
  const upload = nodes(render()).find((n) => n.type === ManualUpload)
  upload.props.onMedia([aiPhoto, { ...aiPhoto, id: '00000000-0000-4000-8000-000000000003', filename: '00000000-0000-4000-8000-000000000003.png', kind: 'real', slot: 1 }])
  assert.equal(state[1].manual_media.length, 2)
  assert.equal(nodes(render()).filter((n) => n.type === 'img').length, 2, 'uploaded variants appear before inclusion')
  const legacy = { ...row(), card_kind: 'legacy', offers: { ...row().offers, ...row('raw').offers, ...row('guide').offers } }
  const old = editor(legacy)
  assert.equal(nodes(old.render()).filter((n) => n.type === 'img').length, 1)
  assert.equal(nodes(old.render()).filter((n) => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked).length, 6)
})

test('save/publish/unpublish keep existing API bodies and refresh; required errors appear only after save', async () => {
  const before = globalThis.fetch
  try {
    let saved = row()
    const requests: any[] = []
    globalThis.fetch = async (url, init) => {
      if (init?.method) {
        requests.push({ url, method: init.method, body: JSON.parse(String(init.body)) })
        const body = requests.at(-1).body
        if (body.card) saved = { ...saved, title: body.card.title, description: body.card.description, offers: body.card.offers }
        if (body.action) saved.published_at = body.action === 'publish' ? '2026-11-05' : null
        return Response.json(saved)
      }
      return Response.json([saved])
    }
    const { render } = editor()
    control(render(), 'Название').props.onChange({ target: { value: 'Изменённое имя' } })
    await button(render(), 'Сохранить карточку').props.onClick()
    assert.equal(requests[0].method, 'PATCH')
    assert.equal(requests[0].body.card.title, 'Изменённое имя')
    assert.equal(requests[0].body.card.offers.finished.title, 'Название предложения')
    assert.equal(button(render(), 'Опубликовать на сайте').props.disabled, false)
    await button(render(), 'Опубликовать на сайте').props.onClick()
    assert.deepEqual(requests[1].body, { action: 'publish' })
    assert.ok(text(render()).includes('Опубликовано на сайте'))
    assert.ok(nodes(render()).some((n) => n.type === 'a' && n.props.href === 'https://istraart.ru/catalog/card-finished'))
    await button(render(), 'Снять с публикации').props.onClick()
    assert.deepEqual(requests[2].body, { action: 'unpublish' })
    assert.equal(nodes(render()).some((n) => n.type === 'a'), false)
    control(render(), 'Название').props.onChange({ target: { value: '' } })
    assert.equal(nodes(render()).some((n) => n.props?.['aria-invalid']), false)
    control(render(), 'Адрес карточки').props.onChange({ target: { value: 'invalid slug' } })
    await button(render(), 'Сохранить карточку').props.onClick()
    assert.equal(requests.length, 3)
    assert.ok(control(render(), 'Название').props['aria-invalid'])
    assert.ok(nodes(render()).some((n) => n.type === 'details' && n.props.open), 'extra fields open to reveal errors')
  } finally { globalThis.fetch = before }
})

test('source is visible and IstraArt exposes RU Social only, with independent guards and no EN send', async () => {
  const before = globalThis.fetch
  try {
    const source = { ...item, originKind: 'own', processingMode: 'ai', generatedTitle: 'Текст соцсетей', generatedText: 'Публикация', sourceLanguage: 'ru', status: 'ready', enText: '', ruText: '', aiReview: { status: 'passed', risk: 'low', quality: { passed: true } }, ruAccountId: 'ru-channel', ruApprovedAt: null, enApprovedAt: null }
    const channels = { accounts: [{ id: 'ru-channel', name: 'RU', username: '@channel', status: 'connected', active: true }], ru: null, en: null }
    const state: any[] = ['', source.generatedTitle, source.generatedText, '', '', channels, 'ru-channel', '', true, false, false, null, '', false, false]
    const CardEditor = () => null
    const render = view('../components/sections/content-factory-items-view.tsx', 'ItemDetail', state, {
      './catalog-card-editor': { CatalogCardEditor: CardEditor }, 'lucide-react': { X: () => null }, '@/components/primitives': { StatusPill: () => null }, '@/components/project-selector': {}, '@/components/i18n-provider': { useI18n: () => ({ t: ru }) },
    })
    let updated: any = null
    const props = { item: source, project: 'istraart', onClose() {}, onUpdated(value: any) { updated = value } }
    const tree = render(props)
    const cardEditor = nodes(tree).find((n) => n.type === CardEditor)
    assert.equal(cardEditor.props.social, undefined)
    const socialTree = (tree: any) => nodes(tree).find((n) => n.type === 'section' && n.props['aria-label'] === ru.contentFactory.items.socialSection)
    let social = socialTree(tree)
    assert.ok(nodes(tree).some((n) => n.type === 'img' && n.props.alt === 'Оригинальное фото 1'))
    assert.equal(text(social).includes('Публикация RU'), true)
    assert.equal(nodes(social).filter((n) => n.type === 'select').length, 1)
    assert.equal(button(social, ru.contentFactory.items.publishSelected).props.disabled, true)
    const requests: any[] = []
    globalThis.fetch = async (url, init) => {
      if (init?.method) { requests.push({ url: String(url), body: JSON.parse(String(init.body)) }); return Response.json({ ...source, ruApprovedAt: '2026-11-05' }) }
      return Response.json(channels)
    }
    await button(social, ru.contentFactory.items.actionApprove + ' RU').props.onClick()
    assert.ok(requests[0].url.includes('/languages?project=istraart'))
    assert.equal(requests[0].body.action, 'approve_ru')
    assert.equal(requests[0].body.accountId, 'ru-channel')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(updated.ruApprovedAt)
    const approved = { ...source, ruApprovedAt: '2026-11-05' }
    social = socialTree(render({ ...props, item: approved }))
    assert.equal(button(social, ru.contentFactory.items.publishSelected).props.disabled, false)
    await button(social, ru.contentFactory.items.publishSelected).props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(requests[1].body, { language: 'ru' })
    assert.ok(requests[1].url.includes('/publish?project=istraart'))
    assert.equal(requests.some((r) => r.url.includes('/api/catalog/')), false)
    const blocked = { ...source, aiReview: null }
    social = socialTree(render({ ...props, item: blocked }))
    assert.equal(button(social, ru.contentFactory.items.actionApprove + ' RU').props.disabled, true)
    const otherProject = render({ ...props, project: 'other' })
    assert.equal(nodes(otherProject).find((n) => n.type === CardEditor).props.social, undefined)
    assert.equal(nodes(otherProject).filter((n) => n.type === 'section' && n.props['aria-label'] === ru.contentFactory.items.socialSection).length, 1)
    assert.ok(nodes(otherProject).some((n) => n.type === 'aside' && n.props.className.includes('max-w-lg')))
    assert.equal(nodes(socialTree(otherProject)).filter((n) => n.type === 'select').length, 2)
    state[9] = true
    social = socialTree(render({ ...props, item: approved }))
    await button(social, ru.contentFactory.items.publishSelected).props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(requests.filter((r) => r.url.includes('/publish')).some((r) => r.body.language === 'en'), false)
  } finally { globalThis.fetch = before }
})

test('new raw, finished and linked guide submit the same independent-card POST contract', async () => {
  const before = globalThis.fetch
  try {
    for (const kind of ['raw', 'finished', 'guide']) {
      const current = row(kind)
      const { state, render } = editor(current)
      state[1] = null; state[3] = kind; state[4] = kind === 'guide' ? 'finished-parent' : null; state[11] = true
      state[5] = kind === 'finished'; state[6] = kind === 'finished'
      let request: any
      globalThis.fetch = async (url, init) => {
        if (init?.method) { request = { url, method: init.method, body: JSON.parse(String(init.body)) }; return Response.json(current) }
        return Response.json([current])
      }
      await button(render(), 'Сохранить карточку').props.onClick()
      assert.equal(request.url, '/api/catalog/cards?project=istraart')
      assert.equal(request.method, 'POST')
      assert.equal(request.body.contentItemId, item.id)
      assert.equal(request.body.cardKind, kind)
      assert.equal(request.body.parentCardId, kind === 'guide' ? 'finished-parent' : null)
      assert.equal(request.body.createRaw, kind === 'finished')
      assert.equal(request.body.createGuide, kind === 'finished')
      assert.deepEqual(request.body.card.offers, current.offers)
    }
  } finally { globalThis.fetch = before }
})

test('all one/two/three-type combinations create separate drafts with explicit guide parent and no double-click duplication', async () => {
  const before = globalThis.fetch
  try {
    for (const chosen of [['raw'], ['finished'], ['guide'], ['raw','finished'], ['raw','guide'], ['finished','guide'], ['raw','finished','guide']]) {
      const state: any[] = [chosen, chosen.includes('guide') ? chosen.includes('finished') ? 'new' : 'product-2' : '', 'idle', '']
      const render = view('../components/sections/catalog-card-create.tsx', 'CatalogCardCreate', state, { '@/lib/catalog-card': validation, '@/lib/catalog-http': http })
      const bodies: any[] = [], busy: boolean[] = []
      const props = { project: 'istraart', item, cards: [row('finished','product-1'), row('finished','product-2')], disabled: false, beforeCreate: () => true, onBusyChange: (v: boolean) => busy.push(v), onCreated: async () => {} }
      globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ id: `created-${bodies.at(-1).cardKind}` }) }
      const click = button(render(props), 'Создать карточки').props.onClick
      await Promise.all([click(), click()])
      assert.equal(bodies.length, chosen.length)
      assert.deepEqual(new Set(bodies.map((b) => b.cardKind)), new Set(chosen))
      for (const body of bodies) { assert.equal(body.contentItemId, item.id); assert.deepEqual(body.card.offers, {}); assert.equal(body.parentCardId, body.cardKind === 'guide' ? chosen.includes('finished') ? 'created-finished' : 'product-2' : null) }
      assert.deepEqual(busy, [true, false])
      assert.equal(button(render(props), 'Создать карточки').props.disabled, true)
    }
    const state = [['guide'], '', 'idle', '']
    const render = view('../components/sections/catalog-card-create.tsx', 'CatalogCardCreate', state, { '@/lib/catalog-card': validation, '@/lib/catalog-http': http })
    let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}) }
    const props = { project: 'istraart', item, cards: [row('finished','one'), row('finished','two')], disabled: false, beforeCreate: () => true, onBusyChange() {}, onCreated: async () => {} }
    await button(render(props), 'Создать карточки').props.onClick()
    assert.equal(calls, 0); assert.ok(text(render(props)).includes('конкретное изделие'))
  } finally { globalThis.fetch = before }
})

test('uncertain creation response is reconciled by stable slug, keeping partial drafts without duplicate POST', async () => {
  const before = globalThis.fetch
  try {
    const state = [['raw','finished','guide'], 'new', 'idle', '']
    const render = view('../components/sections/catalog-card-create.tsx', 'CatalogCardCreate', state, { '@/lib/catalog-card': validation, '@/lib/catalog-http': http })
    const stored: any[] = [], calls: string[] = []; let fail = true
    globalThis.fetch = async (_url, init) => {
      if (!init?.method) return Response.json(stored)
      const body = JSON.parse(String(init.body)); calls.push(body.cardKind)
      const created = { id: `id-${body.cardKind}`, content_item_id: item.id, card_kind: body.cardKind, parent_card_id: body.parentCardId, slug: body.card.slug }
      stored.push(created)
      if (fail && body.cardKind === 'raw') { fail = false; throw new Error('response lost after commit') }
      return Response.json(created)
    }
    const props = { project: 'istraart', item, cards: [], disabled: false, beforeCreate: () => true, onBusyChange() {}, onCreated: async () => {} }
    await button(render(props), 'Создать карточки').props.onClick()
    assert.equal(state[2], 'error'); assert.equal(stored.length, 2)
    await button(render(props), 'Продолжить создание').props.onClick()
    assert.deepEqual(calls, ['finished','raw','guide'])
    assert.equal(stored.length, 3); assert.equal(new Set(stored.map((c) => c.slug)).size, 3)
    assert.equal(stored.find((c) => c.card_kind === 'guide').parent_card_id, 'id-finished')
    assert.equal(state[2], 'done')
  } finally { globalThis.fetch = before }
})

test('simple multi-upload uses only media POSTs without type/Telegram, keeps earlier files when one fails', async () => {
  const before = globalThis.fetch
  try {
    const render = view('../components/sections/catalog-manual-upload.tsx', 'CatalogManualUpload', [], {})
    let media: any[] = [], count = 0
    const props = { cardId: 'card', project: 'istraart', disabled: false, simple: true, usedSlots: [0,2], onMedia: (value: any[]) => { media = value } }
    let tree = render(props)
    assert.equal(nodes(tree).filter((n) => n.type === 'button').length, 1)
    assert.equal(nodes(tree).filter((n) => n.type === 'select').length, 0)
    const files = [new File(['first'], '1.png'), new File(['second'], '2.png')]
    render.refs[0].current = { files, value: 'selected' }
    globalThis.fetch = async (url, init) => {
      count++; assert.ok(String(url).includes('/api/catalog/cards/card/media?project=istraart')); assert.equal(init?.method, 'POST')
      const form = init?.body as FormData
      assert.equal(form.has('kind'), false)
      assert.equal(form.get('slot'), count === 1 ? '1' : '3')
      assert.equal(await (form.get('file') as File).text(), count === 1 ? 'first' : 'second')
      return count === 1 ? Response.json({ media: [{ ...aiPhoto, kind: 'unclassified', slot: 1 }] }) : Response.json({ error: 'second failed; first preserved' }, { status: 422 })
    }
    await nodes(tree).find((n) => n.type === 'input').props.onChange()
    tree = render(props)
    assert.equal(media.length, 1); assert.equal(media[0].kind, 'unclassified')
    assert.ok(text(tree).includes('second failed'))
    assert.equal(count, 2); assert.equal(await files[0].text(), 'first')
  } finally { globalThis.fetch = before }
})

test('main photo and relative order edit only existing imageIndexes, preserving originals/variants until explicit save', () => {
  const current = row()
  current.offers.finished.imageIndexes = [0,1,2]
  current.manual_media = [aiPhoto, { ...aiPhoto, id: '00000000-0000-4000-8000-000000000003', filename: '00000000-0000-4000-8000-000000000003.png', slot: 1 }, { ...aiPhoto, id: '00000000-0000-4000-8000-000000000004', filename: '00000000-0000-4000-8000-000000000004.png', slot: 2 }]
  current.manual_photo_selection = { '1': '00000000-0000-4000-8000-000000000003', '2': '00000000-0000-4000-8000-000000000004' }
  const { render, state } = editor(current)
  const box = (i: number) => nodes(render()).find((n) => n.type === 'div' && Array.isArray(n.props.children) && n.props.children.some((c: any) => c?.type === 'img' && c.props.alt === `Фото ${i}`))
  button(box(3), 'Сделать главным').props.onClick()
  assert.deepEqual(state[8].offers.finished.imageIndexes, [2,0,1])
  button(box(3), 'Позже').props.onClick()
  assert.deepEqual(state[8].offers.finished.imageIndexes, [0,2,1])
  button(box(2), 'Раньше').props.onClick()
  assert.deepEqual(state[8].offers.finished.imageIndexes, [0,1,2])
  assert.equal(current.manual_media.length, 3); assert.deepEqual(item.originalImageFiles, ['original.png'])
  assert.equal(state[11], true)
})
