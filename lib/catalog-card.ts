import type { ManualPhotoSelection } from './catalog-manual-photo-data.ts'
// Small, pure validation layer for the IstraArt catalog MVP.
// Legacy cards retain three offers; new cards each represent one independent product.
export type OfferKind = 'raw' | 'finished' | 'guide'
export type CatalogCardKind = 'legacy' | OfferKind
export type Offer = {
  title: string
  description: string
  priceRub: number
  available: boolean
  imageIndexes: number[]
}
export type CatalogOffers = Partial<Record<OfferKind, Offer>>
export type CatalogCardInput = {
  slug: string
  title: string
  description: string
  lengthCm: number | null
  diameterCm: number | null
  offers: CatalogOffers
  manualPhotoSelection?: ManualPhotoSelection
}
const kinds: OfferKind[] = ['raw', 'finished', 'guide']

export type CatalogFieldErrors = Record<string, string>

/** One set of field rules for the editor and both write APIs. */
export function catalogCardErrors(input: unknown, photoCount: number, publication = false, kind: CatalogCardKind = 'legacy'): CatalogFieldErrors {
  const errors: CatalogFieldErrors = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { _form: 'Проверьте данные карточки.' }
  const v = input as Record<string, unknown>
  if (!Number.isSafeInteger(photoCount) || photoCount < 0 || photoCount > 10) errors._form = 'Исходные фотографии недоступны или их больше 10.'
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160) errors.title = 'Укажите название — от 1 до 160 символов.'
  if (typeof v.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug) || v.slug.length > 100) errors.slug = 'Используйте латинские буквы, цифры и одиночные дефисы, до 100 символов.'
  if (typeof v.description !== 'string' || v.description.length > 10000) errors.description = 'Описание находки — не более 10 000 символов.'
  for (const key of ['lengthCm', 'diameterCm']) {
    const n = v[key]
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 10000)) errors[key] = 'Укажите размер больше 0 и не больше 10 000 см или оставьте поле пустым.'
  }
  if (!v.offers || typeof v.offers !== 'object' || Array.isArray(v.offers)) errors.offers = 'Проверьте предложения карточки.'
  else {
    const offers = v.offers as Record<string, unknown>
    if (kind !== 'legacy' && Object.keys(offers).some((key) => key !== kind)) errors.offers = 'Независимая карточка может содержать только предложение своего типа.'
    if (publication && !Object.keys(offers).length) errors.offers = 'Добавьте хотя бы одно заполненное предложение для публикации.'
    for (const [kind, value] of Object.entries(offers)) {
      if (!kinds.includes(kind as OfferKind)) { errors.offers = 'Допустимы только заготовка, готовое изделие и DIY-гайд.'; continue }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.offers = 'Проверьте поля предложения.'; continue }
      const o = value as Record<string, unknown>
      const prefix = `offers.${kind}.`
      if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 160) errors[prefix+'title'] = 'Укажите название предложения — от 1 до 160 символов.'
      if (typeof o.description !== 'string' || o.description.length > 5000 || (publication && !o.description.trim())) errors[prefix+'description'] = publication ? 'Добавьте описание предложения, до 5000 символов.' : 'Описание предложения — не более 5000 символов.'
      if (typeof o.priceRub !== 'number' || !Number.isSafeInteger(o.priceRub) || o.priceRub <= 0 || o.priceRub > 10000000) errors[prefix+'priceRub'] = 'Укажите подтверждённую цену: целое число от 1 до 10 000 000 ₽.'
      if (typeof o.available !== 'boolean') errors[prefix+'available'] = 'Явно выберите доступность предложения.'
      if (!Array.isArray(o.imageIndexes) || o.imageIndexes.length > 10 || !o.imageIndexes.every((n) => Number.isSafeInteger(n) && n >= 0 && n < photoCount) || (publication && (!o.imageIndexes.length || new Set(o.imageIndexes).size !== o.imageIndexes.length))) errors[prefix+'imageIndexes'] = 'Выберите хотя бы одно доступное исходное фото без повторов.'
      if (Object.keys(o).some((key) => !['title','description','priceRub','available','imageIndexes'].includes(key))) errors._form = 'Предложение содержит неизвестные поля.'
    }
  }
  if (v.manualPhotoSelection !== undefined && (!v.manualPhotoSelection || typeof v.manualPhotoSelection !== 'object' || Array.isArray(v.manualPhotoSelection)
    || Object.entries(v.manualPhotoSelection).some(([slot, id]) => !/^[0-9]$/.test(slot) || Number(slot) >= photoCount || typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)))) errors.manualPhotoSelection = 'Выберите изображение карточки для каждой используемой позиции.'
  if (Object.keys(v).some((key) => !['slug','title','description','lengthCm','diameterCm','offers','manualPhotoSelection'].includes(key))) errors._form = 'Карточка содержит неизвестные поля.'
  return errors
}
export function validateCatalogCard(input: unknown, photoCount: number, kind: CatalogCardKind = 'legacy'): input is CatalogCardInput {
  return Object.keys(catalogCardErrors(input, photoCount, false, kind)).length === 0
}

export function suggestCatalogCard(source: { id: string; originalText?: string; ownBrief?: string; generatedTitle?: string }): CatalogCardInput {
  const text = source.originalText?.trim() || source.ownBrief?.trim() || source.generatedTitle?.trim() || ''
  const title = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 160) || 'Собственный материал'
  const alphabet: Record<string, string> = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }
  const stem = title.toLowerCase().replace(/[а-яё]/g, (c) => alphabet[c]).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '') || 'material'
  const suffix = source.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'new'
  return { slug: `${stem}-${suffix}`, title, description: '', lengthCm: null, diameterCm: null, offers: {} }
}

/** Never expose an unfilled offer as a purchasable product. */
export function publicCatalogCard(input: CatalogCardInput) {
  const { manualPhotoSelection: _internal, ...publicInput } = input
  return {
    ...publicInput,
    offers: Object.fromEntries(
      kinds.filter((kind) => input.offers[kind] !== undefined)
        .map((kind) => [kind, input.offers[kind]]),
    ),
  }
}

/** Draft offers may be absent; every published offer needs confirmed content and a photo. */
export function publishableCatalogCard(input: unknown, photoCount: number, kind: CatalogCardKind = 'legacy'): input is CatalogCardInput {
  return Object.keys(catalogCardErrors(input, photoCount, true, kind)).length === 0
}
