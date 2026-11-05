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
  assert.equal(nodes(tree).filter((n) => n.type === 'button' && text(n) === 'Сохранить').length, 1)
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

test('only independent material/product cards are selectable; old guides expose deletion only in a collapsed legacy list', () => {
  const finished = row(), raw = row('raw', 'raw'), guide = { ...row('guide','guide'), title: 'HIDDEN_GUIDE' }
  const { state, render } = editor(finished, [finished, raw, guide])
  control(render(), 'Товары').props.onChange({ target: { value: 'raw' } })
  assert.equal(state[1].id, 'raw')
  assert.equal(nodes(render()).find((n) => n.type === ChatGptPrompt).props.task, 'raw')
  control(render(), 'Товары').props.onChange({ target: { value: 'card' } })
  assert.equal(nodes(render()).find((n) => n.type === ChatGptPrompt).props.task, 'finished')
  const legacy = nodes(render()).find((n) => n.type === 'details' && text(n).includes('HIDDEN_GUIDE'))
  assert.ok(legacy); assert.equal(!!legacy.props.open, false)
  assert.ok(button(legacy, 'Удалить товар'))
  assert.equal(nodes(control(render(), 'Товары')).some((n) => text(n) === 'HIDDEN_GUIDE'), false)
  assert.equal(state[2].length, 3)
  assert.equal(state[2][2].parent_card_id, 'card')
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
  assert.equal(nodes(old.render()).filter((n) => n.type === 'img').length, 0)
  assert.ok(text(old.render()).includes('Данные сохранены'))
  assert.equal(button(old.render(), 'Сохранить'), undefined)
  assert.equal(Object.keys(legacy.offers).length, 3)
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
    await button(render(), 'Сохранить').props.onClick()
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
    await button(render(), 'Сохранить').props.onClick()
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
      '@/lib/catalog-http': http, './catalog-card-editor': { CatalogCardEditor: CardEditor }, './own-material-upload': { OwnMaterialUpload: () => null }, 'lucide-react': { X: () => null }, '@/components/primitives': { StatusPill: () => null }, '@/components/project-selector': {}, '@/components/i18n-provider': { useI18n: () => ({ t: ru }) },
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

test('new raw and finished products submit the same independent-card POST contract', async () => {
  const before = globalThis.fetch
  try {
    for (const kind of ['raw', 'finished']) {
      const current = row(kind)
      const { state, render } = editor(current)
      state[1] = null; state[3] = kind; state[4] = null; state[11] = true
      state[5] = false; state[6] = false
      let request: any
      globalThis.fetch = async (url, init) => {
        if (init?.method) { request = { url, method: init.method, body: JSON.parse(String(init.body)) }; return Response.json(current) }
        return Response.json([current])
      }
      await button(render(), 'Сохранить').props.onClick()
      assert.equal(request.url, '/api/catalog/cards?project=istraart')
      assert.equal(request.method, 'POST')
      assert.equal(request.body.contentItemId, item.id)
      assert.equal(request.body.cardKind, kind)
      assert.equal(request.body.parentCardId, null)
      assert.equal(request.body.createRaw, false)
      assert.equal(request.body.createGuide, false)
      assert.deepEqual(request.body.card.offers, current.offers)
    }
  } finally { globalThis.fetch = before }
})

test('single type creates exactly one independent product; double clicks and uncertain responses do not duplicate it', async () => {
  const before = globalThis.fetch
  try {
    for (const kind of ['raw','finished']) {
      const state = [kind, 'idle', '']
      const render = view('../components/sections/catalog-card-create.tsx', 'CatalogCardCreate', state, { '@/lib/catalog-card': validation, '@/lib/catalog-http': http })
      const stored: any[] = []; let posts = 0, fail = true
      globalThis.fetch = async (_url, init) => {
        if (!init?.method) return Response.json(stored)
        posts++; const body = JSON.parse(String(init.body))
        assert.equal(body.cardKind, kind); assert.equal(body.parentCardId, null)
        assert.equal(body.createGuide, undefined); assert.equal(body.createRaw, undefined)
        assert.deepEqual(body.card.offers, {})
        const created = { id: 'new-product', content_item_id: item.id, card_kind: kind, parent_card_id: null, slug: body.card.slug }
        stored.push(created)
        if (fail) { fail = false; throw new Error('response lost after commit') }
        return Response.json(created)
      }
      const props = { project: 'istraart', item, cards: [], disabled: false, beforeCreate: () => true, onBusyChange() {}, onCreated: async () => {} }
      let tree = render(props)
      assert.equal(nodes(tree).filter((n) => n.type === 'input').length, 2)
      assert.ok(nodes(tree).filter((n) => n.type === 'input').every((n) => n.props.type === 'radio'))
      assert.equal(text(tree).includes('DIY'), false)
      const click = button(tree, 'Создать товар').props.onClick
      await Promise.all([click(), click()])
      assert.equal(state[1], 'error'); assert.equal(stored.length, 1)
      await button(render(props), 'Проверить создание').props.onClick()
      assert.equal(posts, 1); assert.equal(stored.length, 1); assert.equal(state[1], 'done')
      assert.equal(button(render(props), 'Создать товар').props.disabled, true)
      button(render(props), 'Ещё один товар').props.onClick()
      tree = render(props)
      await button(tree, 'Создать товар').props.onClick()
      assert.equal(posts, 2); assert.equal(stored.length, 2)
      assert.notEqual(stored[0].slug, stored[1].slug)
    }
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

test('desktop source upload uses original-images only and preserves successfully appended photos on a later error', async () => {
  const before = globalThis.fetch
  try {
    const render = view('../components/sections/own-material-upload.tsx', 'OwnMaterialUpload', [], {})
    const updates: any[] = [], requests: any[] = []
    const props = { itemId: item.id, disabled: false, onUpdated: (value: any) => updates.push(value) }
    const tree = render(props)
    const files = [new File(['one'], 'one.png'), new File(['two'], 'two.png')]
    render.refs[0].current = { files, value: 'files' }
    globalThis.fetch = async (url, init) => {
      requests.push(String(url)); assert.equal(init?.method, 'POST')
      assert.deepEqual([...(init?.body as FormData).keys()], ['file'])
      return requests.length === 1 ? Response.json({ ...item, originalImageFiles: [...item.originalImageFiles, 'one.png'] }) : Response.json({ error: 'later upload failed' }, { status: 409 })
    }
    await nodes(tree).find((n) => n.type === 'input').props.onChange()
    assert.equal(updates.length, 1); assert.deepEqual(updates[0].originalImageFiles, ['original.png','one.png'])
    assert.ok(requests.every((url) => url.includes('/original-images?project=istraart')))
    assert.ok(text(render(props)).includes('later upload failed'))
    assert.equal(await files[0].text(), 'one')
  } finally { globalThis.fetch = before }
})

test('source text additions use existing ownBrief edit without overwriting Telegram original', async () => {
  const before = globalThis.fetch
  try {
    const source = { ...item, originKind: 'own', processingMode: 'ai', generatedTitle: '', generatedText: '', sourceLanguage: null, status: 'new', enText: '', ruText: '', aiReview: null, ruApprovedAt: null, enApprovedAt: null }
    const render = view('../components/sections/content-factory-items-view.tsx', 'ItemDetail', [], {
      '@/lib/catalog-http': http, './catalog-card-editor': { CatalogCardEditor: () => null }, './own-material-upload': { OwnMaterialUpload: () => null }, 'lucide-react': { X: () => null }, '@/components/primitives': { StatusPill: () => null }, '@/components/project-selector': {}, '@/components/i18n-provider': { useI18n: () => ({ t: ru }) },
    })
    const requests: any[] = []
    globalThis.fetch = async (url, init) => { if (init?.method) { requests.push(JSON.parse(String(init.body))); return Response.json({ ...source, ownBrief: 'Дополнительные факты' }) }; return Response.json({ accounts: [], ru: null, en: null }) }
    const props = { item: source, project: 'istraart', onClose() {}, onUpdated() {} }
    control(render(props), 'Дополнительный исходный текст').props.onChange({ target: { value: 'Дополнительные факты' } })
    button(render(props), 'Сохранить исходный текст').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(requests, [{ ownBrief: 'Дополнительные факты' }])
    assert.equal(source.originalText, 'Коряга')
  } finally { globalThis.fetch = before }
})

test('loading old guide/legacy records selects only a standalone product and never writes or converts old data', async () => {
  const before = globalThis.fetch
  try {
    const old = { ...row('guide','old-guide'), published_at: '2026-11-05' }
    const legacy = { ...row(), id: 'legacy', card_kind: 'legacy', published_at: '2026-11-05' }
    const raw = { ...row('raw','raw-product'), published_at: '2026-11-05' }
    const records = [old, legacy, raw], original = structuredClone(records)
    const { render, state } = editor()
    let requests = 0
    globalThis.fetch = async (_url, init) => { requests++; assert.equal(init?.method, undefined); return Response.json(records) }
    await nodes(render()).find((n) => n.type === CardCreate).props.onCreated(old.id)
    assert.equal(state[1].id, raw.id)
    assert.equal(nodes(render()).find((n) => n.type === ChatGptPrompt).props.task, 'raw')
    assert.equal(nodes(render()).some((n) => n.type === 'option' && n.props.value === old.id), false)
    assert.equal(nodes(render()).some((n) => n.type === 'option' && n.props.value === legacy.id), false)
    assert.deepEqual(records, original)
    assert.equal(requests, 1)
  } finally { globalThis.fetch = before }
})

test('delete product confirms the stored title, cancels without a request, prevents duplicate clicks, refreshes only on success', async () => {
  const beforeFetch = globalThis.fetch, beforeWindow = globalThis.window
  try {
    const { render, state } = editor()
    const confirmations: string[] = []
    let allow = false, requests = 0
    globalThis.window = { confirm: (message: string) => { confirmations.push(message); return allow } } as unknown as Window & typeof globalThis
    globalThis.fetch = async () => { requests++; throw new Error('should not fetch on cancel') }
    await button(render(), 'Удалить товар').props.onClick()
    assert.equal(requests, 0); assert.ok(confirmations[0].includes('Название карточки'))
    allow = true
    globalThis.fetch = async (_url, init) => { requests++; assert.equal(init?.method, 'DELETE'); return Response.json({ error: 'Сначала удалите гайд' }, { status: 409 }) }
    await button(render(), 'Удалить товар').props.onClick()
    assert.ok(text(render()).includes('Сначала удалите гайд')); assert.equal(state[1].id, 'card')
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => { release = resolve })
    const urls: string[] = []
    globalThis.fetch = async (url, init) => {
      urls.push(String(url))
      if (init?.method === 'DELETE') { await wait; return Response.json({ id: 'card' }) }
      return Response.json([row('raw','remaining')])
    }
    const handler = button(render(), 'Удалить товар').props.onClick
    const pending = handler()
    await handler()
    assert.equal(urls.length, 1, 'in-flight duplicate cannot issue another DELETE')
    release(); await pending
    assert.equal(state[1].id, 'remaining')
    assert.deepEqual(urls, ['/api/catalog/cards/card?project=istraart', '/api/catalog/cards?project=istraart'])
  } finally { globalThis.fetch = beforeFetch; globalThis.window = beforeWindow }
})

test('materials show IstraArt deletion only, warn with related count, cancel safely and remove just the successful row', async () => {
  const beforeFetch = globalThis.fetch, beforeWindow = globalThis.window
  try {
    const source = { ...item, originKind: 'own', generatedTitle: '', createdAt: '2026-11-05' }
    const second = { ...source, id: 'second' }
    const state: any[] = [[source, second], '', source, false]
    const primitives = { SectionHeader: () => null, StatusPill: () => null, TableShell: () => null, Th: () => null, Td: () => null }
    const render = view('../components/sections/content-factory-items-view.tsx', 'ContentFactoryItemsView', state, {
      '@/lib/catalog-http': http, './catalog-card-editor': { CatalogCardEditor: () => null }, './own-material-upload': { OwnMaterialUpload: () => null }, 'lucide-react': { X: () => null },
      '@/components/primitives': primitives, '@/components/project-selector': { ProjectSelector: () => null }, '@/components/i18n-provider': { useI18n: () => ({ t: ru }) },
    })
    const props = { project: 'istraart', onProjectChange() {} }
    assert.equal(button(render({ ...props, project: 'aurelmar' }), 'Удалить'), undefined)
    let confirmed = 0, allow = false, deletes = 0, related = true, failure = false
    globalThis.window = { confirm: () => { confirmed++; return allow } } as unknown as Window & typeof globalThis
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'DELETE') { deletes++; return failure ? Response.json({ error: 'Материал изменился' }, { status: 409 }) : Response.json({ id: item.id }) }
      return Response.json(related ? [{ content_item_id: item.id }, { content_item_id: item.id }] : [])
    }
    let stopped = false
    const event = { stopPropagation() { stopped = true } }
    // Row click must not open the detail drawer when deleting.
    button(render(props), 'Удалить').props.onClick(event)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(stopped, true); assert.equal(confirmed, 0); assert.equal(deletes, 0)
    assert.ok(text(render(props)).includes('карточки товаров: 2'))
    related = false
    button(render(props), 'Удалить').props.onClick(event)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(confirmed, 1); assert.equal(deletes, 0); assert.equal(state[0].length, 2)
    allow = true; failure = true
    button(render(props), 'Удалить').props.onClick(event)
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(text(render(props)).includes('Материал изменился')); assert.equal(state[0].length, 2)
    failure = false
    button(render(props), 'Удалить').props.onClick(event)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(state[0].map((r: any) => r.id), ['second']); assert.equal(state[2], null)
  } finally { globalThis.fetch = beforeFetch; globalThis.window = beforeWindow }
})

test('a successful DELETE is reflected locally even if refreshing cards fails', async () => {
  const beforeFetch = globalThis.fetch, beforeWindow = globalThis.window
  try {
    const { render, state } = editor()
    globalThis.window = { confirm: () => true } as unknown as Window & typeof globalThis
    globalThis.fetch = async (_url, init) => init?.method === 'DELETE' ? Response.json({ id: 'card' }) : Response.json({ error: 'Каталог временно недоступен' }, { status: 503 })
    await button(render(), 'Удалить товар').props.onClick()
    assert.equal(state[1], null); assert.deepEqual(state[2], [])
    assert.ok(text(render()).includes('Каталог временно недоступен'))
    assert.equal(button(render(), 'Удалить товар'), undefined)
  } finally { globalThis.fetch = beforeFetch; globalThis.window = beforeWindow }
})
