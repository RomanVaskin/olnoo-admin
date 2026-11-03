import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem, setItemImageFilename } from '@/lib/content-factory-items'
import { generateContentFactoryCover, readContentFactoryCover, removeContentFactoryCover, writeContentFactoryCover } from '@/lib/content-factory-image'
import { isValidProjectSlug } from '@/lib/social-instagram-uploads'

async function ownItem(req: Request, params: Promise<{ id: string }>) {
  const { id } = await params
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId || !isValidProjectSlug(project)) return null
  const item = await getItem(pool, projectId, id)
  return item ? { item, project, projectId } : null
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owned = await ownItem(req, params)
  if (!owned?.item.imageFilename) return new NextResponse(null, { status: 404 })
  const bytes = await readContentFactoryCover(owned.project, owned.item.imageFilename).catch(() => null)
  if (!bytes) return new NextResponse(null, { status: 404 })
  return new NextResponse(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owned = await ownItem(req, params)
  if (!owned) return NextResponse.json({ error: 'Material not found for this project.' }, { status: 404 })
  const { item, project, projectId } = owned
  if (item.processingMode === 'copy') return NextResponse.json({ error: 'Partner copy does not use AI image generation.' }, { status: 409 })
  if (!item.generatedText.trim() || !['ready', 'needs_review'].includes(item.status) || item.socialPostId) {
    return NextResponse.json({ error: 'Prepare the material before generating an image; published materials cannot be changed.' }, { status: 409 })
  }

  let filename = ''
  try {
    const bytes = await generateContentFactoryCover(pool, projectId, item.generatedTitle, item.generatedText)
    filename = await writeContentFactoryCover(project, bytes)
    const updated = await setItemImageFilename(pool, projectId, item.id, filename)
    if (!updated) {
      await removeContentFactoryCover(project, filename).catch(() => {})
      return NextResponse.json({ error: 'Material changed while generating the image. Please refresh it.' }, { status: 409 })
    }
    await removeContentFactoryCover(project, item.imageFilename).catch(() => {})
    return NextResponse.json(updated)
  } catch (err) {
    if (filename) await removeContentFactoryCover(project, filename).catch(() => {})
    console.error('content-factory image generation failed', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not generate an image. The material is unchanged.' }, { status: 502 })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owned = await ownItem(req, params)
  if (!owned) return NextResponse.json({ error: 'Material not found for this project.' }, { status: 404 })
  const { item, project, projectId } = owned
  if (!['ready', 'needs_review'].includes(item.status) || item.socialPostId) {
    return NextResponse.json({ error: 'Published materials cannot be changed.' }, { status: 409 })
  }
  if (!item.imageFilename) return NextResponse.json(item)
  const updated = await setItemImageFilename(pool, projectId, item.id, '')
  if (!updated) return NextResponse.json({ error: 'Material changed. Please refresh it.' }, { status: 409 })
  await removeContentFactoryCover(project, item.imageFilename).catch(() => {})
  return NextResponse.json(updated)
}
