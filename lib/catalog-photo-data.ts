export type ProcessedCatalogPhoto = {
  id: string
  originalIndex: number
  originalFilename: string
  filename: string
  model: string
  provider: 'gemini'
  createdAt: string
}
export type CatalogPhotoVersions = Record<string, string>
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const originalFile = /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/

export function processedCatalogPhotos(value: unknown): ProcessedCatalogPhoto[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is ProcessedCatalogPhoto => v && typeof v === 'object'
    && typeof v.id === 'string' && uuid.test(v.id) && Number.isInteger(v.originalIndex) && v.originalIndex >= 0 && v.originalIndex < 10
    && typeof v.originalFilename === 'string' && originalFile.test(v.originalFilename)
    && v.filename === `${v.id}.png` && v.provider === 'gemini' && typeof v.model === 'string' && v.model.length > 0
    && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)))
}

export function catalogPhotoVersionsValid(value: unknown, files: unknown, history: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(files)) return false
  const versions = processedCatalogPhotos(history)
  return Object.entries(value).every(([key, id]) => /^[0-9]$/.test(key) && typeof id === 'string'
    && versions.some((v) => v.id === id && v.originalIndex === Number(key) && v.originalFilename === files[Number(key)]))
}
