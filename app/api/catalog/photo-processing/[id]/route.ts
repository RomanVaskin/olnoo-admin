import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { processedCatalogPhotos } from '@/lib/catalog-photo-data'
import { CatalogPhotoError, processCatalogPhoto } from '@/lib/catalog-photo-processing'
const headers = { 'Cache-Control': 'no-store' }
async function source(req: Request, id: string) {
  if (new URL(req.url).searchParams.get('project') !== 'istraart' || !/^[0-9a-f-]{36}$/i.test(id)) return null
  const projectId = await resolveProjectId('istraart')
  if (!projectId) return null
  const { rows } = await pool.query("SELECT original_image_files, processed_image_versions FROM content_factory_items WHERE id=$1 AND project_id=$2 AND origin_kind='own'", [id, projectId])
  return rows[0] ? { projectId, row: rows[0] } : null
}
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const found = await source(req, id)
  if (!found) return NextResponse.json({ error: 'Материал не найден.' }, { status: 404, headers })
  const versions = processedCatalogPhotos(found.row.processed_image_versions).filter((v) => found.row.original_image_files?.[v.originalIndex] === v.originalFilename)
  return NextResponse.json(versions.map(({ id, originalIndex, model, createdAt }) => ({ id, originalIndex, model, createdAt })), { headers })
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get('origin')
  if (origin && origin !== new URL(req.url).origin) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers })
  const { id } = await params
  const found = await source(req, id)
  if (!found) return NextResponse.json({ error: 'Материал не найден.' }, { status: 404, headers })
  const body = await req.json().catch(() => null)
  if (!body || Object.keys(body).length !== 1 || !Number.isInteger(body.originalIndex) || body.originalIndex < 0 || body.originalIndex > 9) return NextResponse.json({ error: 'Выберите исходное фото.' }, { status: 400, headers })
  try {
    const { id: version, originalIndex, model, createdAt } = await processCatalogPhoto(pool, found.projectId, id, body.originalIndex)
    return NextResponse.json({ id: version, originalIndex, model, createdAt }, { status: 201, headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof CatalogPhotoError ? error.message : 'Не удалось сохранить обработанное фото. Оригинал и прежние версии сохранены.' }, { status: error instanceof CatalogPhotoError ? 422 : 500, headers })
  }
}
