import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem } from '@/lib/content-factory-items'
import { syncOriginalImages } from '@/lib/content-factory-original-images'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  const { id } = await params
  const item = await getItem(pool, projectId, id)
  if (!item || item.processingMode !== 'copy') return NextResponse.json({ error: 'Partner copy not found.' }, { status: 404 })
  if (item.socialPostId || item.status === 'published' || item.status === 'scheduled') return NextResponse.json({ error: 'Published material cannot be changed.' }, { status: 409 })
  await syncOriginalImages(pool, item)
  const updated = await getItem(pool, projectId, id)
  if (!updated) return NextResponse.json({ error: 'Material disappeared during image download.' }, { status: 404 })
  return NextResponse.json(updated)
}
