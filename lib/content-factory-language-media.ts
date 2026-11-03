import type { ContentFactoryItem } from './content-factory-items.ts'
import { readOriginalImage } from './content-factory-original-images.ts'
import { readContentFactoryCover } from './content-factory-image.ts'
import sharp from 'sharp'

/** Both languages read the same saved media; source files are never rewritten. */
export async function loadLanguageMedia(
  item: ContentFactoryItem,
  projectSlug: string,
  language: 'ru' | 'en',
  readers: {
    original?: typeof readOriginalImage
    cover?: typeof readContentFactoryCover
  } = {},
): Promise<{ images: { bytes: Buffer; mimeType: 'image/jpeg' | 'image/png' }[]; photo?: Buffer }> {
  if (item.processingMode === 'copy') {
    if (item.originalImageError || item.originalImageFiles.length !== item.originalImageUrls.length) throw new Error('Source album is incomplete.')
    const images = await Promise.all(item.originalImageFiles.map(async (filename) => {
      const bytes = await (readers.original ?? readOriginalImage)(item.projectId, item.id, filename)
      if (filename.endsWith('.webp')) return { bytes: await sharp(bytes).jpeg({ quality: 95 }).toBuffer(), mimeType: 'image/jpeg' as const }
      return { bytes, mimeType: filename.endsWith('.png') ? 'image/png' as const : 'image/jpeg' as const }
    }))
    return { images }
  }
  if (item.imageFilename) return { images: [], photo: await (readers.cover ?? readContentFactoryCover)(projectSlug, item.imageFilename) }
  return { images: [] }
}
