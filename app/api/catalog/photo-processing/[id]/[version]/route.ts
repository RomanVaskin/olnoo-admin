import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { processedCatalogPhotos } from '@/lib/catalog-photo-data'
import { readProcessedCatalogPhoto } from '@/lib/catalog-photo-processing'
export async function GET(req: Request, { params }: { params: Promise<{ id: string; version: string }> }) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  const { id, version } = await params
  if (new URL(req.url).searchParams.get('project') !== 'istraart' || !/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(version)) return new NextResponse(null, { status: 404, headers })
  const projectId = await resolveProjectId('istraart')
  if (!projectId) return new NextResponse(null, { status: 404, headers })
  const { rows } = await pool.query("SELECT original_image_files, processed_image_versions FROM content_factory_items WHERE id=$1 AND project_id=$2 AND origin_kind='own'", [id, projectId])
  const record = processedCatalogPhotos(rows[0]?.processed_image_versions).find((v) => v.id === version && rows[0].original_image_files?.[v.originalIndex] === v.originalFilename)
  const bytes = record && await readProcessedCatalogPhoto(projectId, id, record.filename).catch(() => null)
  if (!bytes) return new NextResponse(null, { status: 404, headers })
  return new NextResponse(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/png' } })
}
