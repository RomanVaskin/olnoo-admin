import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem } from '@/lib/content-factory-items'
import { readOriginalImage } from '@/lib/content-factory-original-images'

export async function GET(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return new NextResponse(null, { status: 404 })
  const { id, index } = await params
  if (!/^(?:0|[1-9]\d*)$/.test(index)) return new NextResponse(null, { status: 404 })
  const item = await getItem(pool, projectId, id)
  const filename = item && (item.processingMode === 'copy' || item.originKind === 'own') ? item.originalImageFiles[Number(index)] : undefined
  if (!filename) return new NextResponse(null, { status: 404 })
  const bytes = await readOriginalImage(projectId, id, filename).catch(() => null)
  if (!bytes) return new NextResponse(null, { status: 404 })
  const mime = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
  return new NextResponse(new Uint8Array(bytes), { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}
