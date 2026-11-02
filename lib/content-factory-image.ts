import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Jimp } from 'jimp'
import type { Pool } from 'pg'
import { callAiRouterImage } from './ai-router.ts'
import { getProjectBrandVoice } from './project-brand-voice.ts'
import { isValidProjectSlug } from './social-instagram-uploads.ts'

// Reuses the Admin's persistent, gitignored uploads/ filesystem convention. No source image is
// read or passed to the Router; only the publication theme and this project's Brand Profile are used.
export const CONTENT_FACTORY_IMAGE_ROOT = path.join(process.cwd(), 'uploads', 'content-factory')
const IMAGE_FILENAME = /^[0-9a-f-]{36}\.jpg$/
const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024

export function contentFactoryImagePath(project: string, filename: string): string {
  if (!isValidProjectSlug(project) || !IMAGE_FILENAME.test(filename)) throw new Error('Invalid image path.')
  return path.join(CONTENT_FACTORY_IMAGE_ROOT, project, filename)
}

export function buildContentFactoryImagePrompt(theme: string, visualStyle: string): string {
  return `Create ONE original 1024x1024 editorial photograph or photorealistic illustration, not an advertisement, promotional banner, poster, or template.
VISUAL THEME (interpret as a scene; do not render these words): ${theme}
BRAND PROFILE (visual mood and constraints only; do not render its words):
${visualStyle}

Compose a natural, specific scene with depth, believable light and material detail. Avoid generic stock-photo collage, gradients, floating shapes and text panels. For real-estate themes, prefer architecture, urban settings, buildings or interiors that fit the confirmed topic. Never depict an identifiable specific property as a real project without confirmation; use a generic, non-identifiable scene instead.
The image must contain NO text, letters, digits, logos, signs, labels, interfaces, charts, diagrams or watermarks. Do not copy, imitate or reference any image from the source publication. Return only the image.`
}

export async function generateContentFactoryCover(pool: Pool, projectId: number, title: string, body: string): Promise<Buffer> {
  const brand = await getProjectBrandVoice(pool, projectId)
  const theme = title.trim() || body.trim().split(/[.!?\n]/, 1)[0].slice(0, 180)
  const visualStyle = `Tone and style: ${brand?.toneStyle || '(not specified)'}\nAudience: ${brand?.targetAudience || '(not specified)'}\nConstraints: ${brand?.constraints || '(not specified)'}`
  const png = await callAiRouterImage(buildContentFactoryImagePrompt(theme, visualStyle))
  const image = await Jimp.fromBuffer(png)
  if (image.width !== 1024 || image.height !== 1024) throw new Error('AI Router returned an image with the wrong dimensions.')
  const jpeg = await image.getBuffer('image/jpeg', { quality: 90 })
  if (jpeg.length > MAX_TELEGRAM_PHOTO_BYTES) throw new Error('Generated image is too large for Telegram.')
  return jpeg
}

export async function writeContentFactoryCover(project: string, bytes: Buffer): Promise<string> {
  const filename = `${randomUUID()}.jpg`
  const target = contentFactoryImagePath(project, filename)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, bytes, { flag: 'wx' })
  return filename
}

export async function readContentFactoryCover(project: string, filename: string): Promise<Buffer> {
  return readFile(contentFactoryImagePath(project, filename))
}

export async function removeContentFactoryCover(project: string, filename: string): Promise<void> {
  if (!filename) return
  await unlink(contentFactoryImagePath(project, filename)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err
  })
}
