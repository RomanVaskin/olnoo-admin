import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { validateCatalogCard } from '@/lib/catalog-card'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'Unknown project' }, { status: 400 })
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const { rows } = await pool.query<{ content_item_id: string; published_at: string | null; original_image_files: unknown }>(
    `SELECT c.content_item_id, c.published_at, i.original_image_files
       FROM catalog_cards c JOIN content_factory_items i
         ON i.id = c.content_item_id AND i.project_id = c.project_id
      WHERE c.id = $1 AND c.project_id = $2`, [id, projectId],
  )
  const current = rows[0]
  if (!current) return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  if (body.action === 'publish' && Object.keys(body).length === 1) {
    const updated = await pool.query(
      'UPDATE catalog_cards SET published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = $1 AND project_id = $2 RETURNING id, slug, published_at',
      [id, projectId],
    )
    return NextResponse.json(updated.rows[0])
  }
  if (body.action === 'unpublish' && Object.keys(body).length === 1) {
    const updated = await pool.query(
      'UPDATE catalog_cards SET published_at = NULL, updated_at = now() WHERE id = $1 AND project_id = $2 RETURNING id, slug, published_at',
      [id, projectId],
    )
    return NextResponse.json(updated.rows[0])
  }
  if (!body.card || Object.keys(body).some((key) => key !== 'card')) return NextResponse.json({ error: 'Invalid update' }, { status: 400 })
  if (!Array.isArray(current.original_image_files) || !validateCatalogCard(body.card, current.original_image_files.length)) {
    return NextResponse.json({ error: 'Invalid catalog card' }, { status: 422 })
  }
  const card = body.card
  try {
    const updated = await pool.query(
      `UPDATE catalog_cards SET slug = $1, title = $2, description = $3, length_cm = $4,
         diameter_cm = $5, offers = $6::jsonb, updated_at = now()
       WHERE id = $7 AND project_id = $8 RETURNING id, slug, published_at`,
      [card.slug, card.title, card.description, card.lengthCm, card.diameterCm, JSON.stringify(card.offers), id, projectId],
    )
    return NextResponse.json(updated.rows[0])
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return NextResponse.json({ error: 'Slug already exists' }, { status: 409 })
    throw error
  }
}
