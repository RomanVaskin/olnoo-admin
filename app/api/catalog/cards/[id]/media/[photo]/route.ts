import { withCatalogSchemaGuard } from '@/lib/catalog-schema'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { catalogUuid, manualCatalogPhotos } from '@/lib/catalog-manual-photo-data'
import { readManualCatalogPhoto } from '@/lib/catalog-manual-media'
async function get(req: Request, { params }: { params: Promise<{ id: string; photo: string }> }) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  const { id, photo } = await params
  if (new URL(req.url).searchParams.get('project') !== 'istraart' || !catalogUuid(id) || !catalogUuid(photo)) return new NextResponse(null, { status: 404, headers })
  const projectId = await resolveProjectId('istraart')
  if (!projectId) return new NextResponse(null, { status: 404, headers })
  const { rows } = await pool.query(`SELECT c.manual_media FROM catalog_cards c JOIN content_factory_items i ON i.id=c.content_item_id AND i.project_id=c.project_id WHERE c.id=$1 AND c.project_id=$2 AND i.origin_kind='own'`, [id, projectId])
  const record = manualCatalogPhotos(rows[0]?.manual_media).find((p) => p.id === photo)
  const bytes = record && await readManualCatalogPhoto(projectId, id, record.filename).catch(() => null)
  return bytes ? new NextResponse(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': record!.mimeType } }) : new NextResponse(null, { status: 404, headers })
}

export const GET = withCatalogSchemaGuard(get)
