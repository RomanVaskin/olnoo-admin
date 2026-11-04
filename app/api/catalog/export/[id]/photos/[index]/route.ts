import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { catalogSiteProject, catalogPhotoSelection, publishedCatalogRows } from '@/lib/catalog-export'
import { readProcessedCatalogPhoto } from '@/lib/catalog-photo-processing'
import { readOriginalImage } from '@/lib/content-factory-original-images'
export const dynamic = 'force-dynamic'
export async function GET(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  const project = catalogSiteProject(req.headers.get('x-olnoo-catalog-token'))
  if (!project) return new NextResponse(null, { status: 403, headers })
  const { id, index } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !/^[0-9]$/.test(index)) return new NextResponse(null, { status: 404, headers })
  const [row] = await publishedCatalogRows(pool, project, id)
  const selection = row && catalogPhotoSelection(row, Number(index))
  if (!selection) return new NextResponse(null, { status: 404, headers })
  const filename = selection.filename
  const bytes = await (selection.processed ? readProcessedCatalogPhoto : readOriginalImage)(selection.projectId, selection.itemId, filename).catch(() => null)
  if (!bytes) return new NextResponse(null, { status: 404, headers })
  return new NextResponse(new Uint8Array(bytes), { headers: { ...headers, 'X-Olnoo-Catalog-Project': project, 'Content-Type': filename.endsWith('.png') ? 'image/png' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg' } })
}
