export type ManualCatalogPhoto = { id: string; slot: number; filename: string; kind: 'real' | 'ai'; mimeType: string; origin: 'upload' | 'telegram'; createdAt: string; sourceItemId?: string; sourceIndex?: number }
export type ManualPhotoSelection = Record<string, string>
export const catalogUuid = (v: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)
export function manualCatalogPhotos(raw: unknown): ManualCatalogPhoto[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is ManualCatalogPhoto => p && typeof p === 'object' && typeof p.id === 'string' && catalogUuid(p.id)
    && Number.isInteger(p.slot) && p.slot >= 0 && p.slot < 10 && ['real', 'ai'].includes(p.kind)
    && ['upload', 'telegram'].includes(p.origin) && typeof p.filename === 'string' && new RegExp(`^${p.id}\\.(jpg|png|webp)$`).test(p.filename)
    && ['image/jpeg', 'image/png', 'image/webp'].includes(p.mimeType) && typeof p.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt)))
    .map((p) => ({ id: p.id, slot: p.slot, filename: p.filename, kind: p.kind, mimeType: p.mimeType, origin: p.origin, createdAt: p.createdAt,
      ...(typeof p.sourceItemId === 'string' && catalogUuid(p.sourceItemId) && Number.isInteger(p.sourceIndex) && p.sourceIndex! >= 0 && p.sourceIndex! < 10 ? { sourceItemId: p.sourceItemId, sourceIndex: p.sourceIndex } : {}) }))
}
export function manualPhotoCount(files: unknown, media: unknown): number {
  if (!Array.isArray(files)) return -1
  return Math.max(files.length, ...manualCatalogPhotos(media).map((p) => p.slot + 1))
}
export function manualPhotoSelectionValid(input: { offers: Record<string, { imageIndexes: number[] }>; manualPhotoSelection?: unknown }, files: unknown, media: unknown): boolean {
  if (!Array.isArray(files)) return false
  const raw = input.manualPhotoSelection ?? {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const selection = raw as Record<string, unknown>, photos = manualCatalogPhotos(media)
  const selected = Object.values(input.offers).flatMap((o) => o.imageIndexes)
  if (!Object.entries(selection).every(([key, id]) => /^[0-9]$/.test(key) && selected.includes(Number(key)) && photos.some((p) => p.id === id && p.slot === Number(key)))) return false
  return selected.every((index) => selection[String(index)] ? photos.some((p) => p.id === selection[String(index)] && p.slot === index) : typeof files[index] === 'string')
}
