import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { resolveProjectId } from '@/lib/crm'
import { UPLOADS_ROOT, isValidProjectSlug } from '@/lib/social-instagram-uploads'

const MAX_BYTES = 8 * 1024 * 1024 // Matches Instagram's own JPEG size limit — no need for a
// separate, smaller-than-necessary cap.
const JPEG_MAGIC = [0xff, 0xd8, 0xff]

// Non-secret; only used to turn a saved file into the absolute HTTPS URL Instagram's API needs to
// fetch it from. Overridable for local/test environments the same way TELEGRAM_API_BASE_URL/
// VK_API_BASE_URL override their own base URLs.
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://admin.olnoo.com'

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === JPEG_MAGIC[0] && buf[1] === JPEG_MAGIC[1] && buf[2] === JPEG_MAGIC[2]
}

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  const projectId = await resolveProjectId(project)
  if (!projectId || !isValidProjectSlug(project)) {
    return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'file is empty' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file is too large (max ${MAX_BYTES / (1024 * 1024)}MB)` }, { status: 400 })
  }
  if (file.type && file.type !== 'image/jpeg') {
    return NextResponse.json({ error: 'only JPEG images are supported' }, { status: 400 })
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  if (!isJpeg(bytes)) {
    return NextResponse.json({ error: 'file is not a valid JPEG image' }, { status: 400 })
  }

  // Filename is always a fresh random UUID — the original filename (and anything in it) is never
  // used, so there is no user-controlled path segment anywhere in the write target.
  const dir = path.join(UPLOADS_ROOT, project)
  await mkdir(dir, { recursive: true })
  const filename = `${randomUUID()}.jpg`
  await writeFile(path.join(dir, filename), bytes)

  const url = `${PUBLIC_SITE_URL}/api/social/instagram-image/${project}/${filename}`
  return NextResponse.json({ url })
}
