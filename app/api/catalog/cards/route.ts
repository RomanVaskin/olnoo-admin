import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { validateCatalogCard } from '@/lib/catalog-card'

/** Internal OLNOO Admin route; remains behind the existing external Admin access layer. */
export async function GET(req: Request) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'Unknown project' }, { status: 400 })
  const { rows } = await pool.query(
    'SELECT id, content_item_id, slug, title, description, length_cm, diameter_cm, offers, published_at FROM catalog_cards WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId],
  )
  return NextResponse.json(rows)
}

export async function POST(req: Request) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'Unknown project' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body.contentItemId !== 'string' || !body.card) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const { rows } = await pool.query<{ id: string; original_image_files: unknown }>(
    "SELECT id, original_image_files FROM content_factory_items WHERE id = $1 AND project_id = $2 AND origin_kind = 'own'",
    [body.contentItemId, projectId],
  )
  if (!rows[0]) return NextResponse.json({ error: 'Owner material not found' }, { status: 404 })
  const files = rows[0].original_image_files
  if (!Array.isArray(files) || !validateCatalogCard(body.card, files.length)) return NextResponse.json({ error: 'Invalid catalog card' }, { status: 422 })
  const card = body.card
  try {
    const created = await pool.query(
      `INSERT INTO catalog_cards
        (id, project_id, content_item_id, slug, title, description, length_cm, diameter_cm, offers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING id, slug, published_at`,
      [randomUUID(), projectId, body.contentItemId, card.slug, card.title, card.description, card.lengthCm, card.diameterCm, JSON.stringify(card.offers)],
    )
    return NextResponse.json(created.rows[0], { status: 201 })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return NextResponse.json({ error: 'Card or slug already exists' }, { status: 409 })
    throw error
  }
}
