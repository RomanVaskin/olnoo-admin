// Small, pure validation layer for the IstraArt catalog MVP.
// A natural find has one card with up to three offers. Unfilled offers are NOT for sale.
export type OfferKind = 'raw' | 'finished' | 'guide'
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
}
const kinds: OfferKind[] = ['raw', 'finished', 'guide']

function validOffer(value: unknown, maxPhotoCount: number): value is Offer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.title === 'string' && v.title.trim().length > 0 && v.title.length <= 160
    && typeof v.description === 'string' && v.description.length <= 5000
    && typeof v.priceRub === 'number' && Number.isSafeInteger(v.priceRub) && v.priceRub > 0 && v.priceRub <= 10_000_000
    && typeof v.available === 'boolean'
    && Array.isArray(v.imageIndexes)
    && v.imageIndexes.length <= 10
    && v.imageIndexes.every((n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < maxPhotoCount)
    && Object.keys(v).every((k) => ['title', 'description', 'priceRub', 'available', 'imageIndexes'].includes(k))
}

export function validateCatalogCard(input: unknown, photoCount: number): input is CatalogCardInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  if (!Number.isSafeInteger(photoCount) || photoCount < 0 || photoCount > 10) return false
  const v = input as Record<string, unknown>
  if (typeof v.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug) || v.slug.length > 100) return false
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160) return false
  if (typeof v.description !== 'string' || v.description.length > 10000) return false
  if (![v.lengthCm, v.diameterCm].every((n) => n === null || (typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 10000))) return false
  if (!v.offers || typeof v.offers !== 'object' || Array.isArray(v.offers)) return false
  const offers = v.offers as Record<string, unknown>
  if (!Object.keys(offers).every((key) => kinds.includes(key as OfferKind))) return false
  if (!Object.values(offers).every((offer) => validOffer(offer, photoCount))) return false
  return Object.keys(v).every((key) => ['slug','title','description','lengthCm','diameterCm','offers'].includes(key))
}

/** Never expose an unfilled offer as a purchasable product. */
export function publicCatalogCard(input: CatalogCardInput) {
  return {
    ...input,
    offers: Object.fromEntries(
      kinds.filter((kind) => input.offers[kind] !== undefined)
        .map((kind) => [kind, input.offers[kind]]),
    ),
  }
}

/** Draft offers may be absent; every published offer needs confirmed content and a photo. */
export function publishableCatalogCard(input: unknown, photoCount: number): input is CatalogCardInput {
  return validateCatalogCard(input, photoCount) && Object.keys(input.offers).length > 0
    && Object.values(input.offers).every((offer) => !!offer.description.trim() && offer.imageIndexes.length > 0
      && new Set(offer.imageIndexes).size === offer.imageIndexes.length)
}
