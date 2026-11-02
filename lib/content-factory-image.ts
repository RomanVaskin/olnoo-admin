import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Jimp } from 'jimp'
import type { Pool } from 'pg'
import { callAiRouterImage } from './ai-router.ts'
import { buildProjectAiContext, projectAiContextBlock } from './project-ai-context.ts'
import { isValidProjectSlug } from './social-instagram-uploads.ts'

// Reuses the Admin's persistent, gitignored uploads/ filesystem convention. No source image is
// read or passed to the Router; only the approved draft and this project's Brand Profile are used.
export const CONTENT_FACTORY_IMAGE_ROOT = path.join(process.cwd(), 'uploads', 'content-factory')
const IMAGE_FILENAME = /^[0-9a-f-]{36}\.jpg$/
const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024

export function contentFactoryImagePath(project: string, filename: string): string {
  if (!isValidProjectSlug(project) || !IMAGE_FILENAME.test(filename)) throw new Error('Invalid image path.')
  return path.join(CONTENT_FACTORY_IMAGE_ROOT, project, filename)
}

export function buildContentFactoryImagePrompt(title: string, body: string, projectContext: string): string {
  return `Create ONE original square editorial cover image for this project's finished publication.
PROJECT CONTEXT (Brand Profile and verified facts):
${projectContext}

PUBLICATION TITLE: ${title}
PUBLICATION TEXT: ${body}

Use the subject and visual style appropriate to the project's Brand Profile. Make a clear, attractive composition at 1024x1024. Do not depict unsupported specific people, properties, products, numbers, or claims. No text, letters, numbers, logos, watermarks, screenshots, or source-channel branding. Do not reproduce or reference any image from the source publication. Return one original image.`
}

export async function generateContentFactoryCover(pool: Pool, projectId: number, title: string, body: string): Promise<Buffer> {
  const context = projectAiContextBlock(await buildProjectAiContext(pool, projectId))
  const png = await callAiRouterImage(buildContentFactoryImagePrompt(title, body, context))
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
