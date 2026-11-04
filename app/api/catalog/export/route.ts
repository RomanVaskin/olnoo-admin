import { withCatalogSchemaGuard } from '@/lib/catalog-schema'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { catalogSiteProject, catalogPublicCards, publishedCatalogRows } from '@/lib/catalog-export'
export const dynamic = 'force-dynamic'
async function get(req: Request) {
  const project = catalogSiteProject(req.headers.get('x-olnoo-catalog-token'))
  if (!project) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  const rows = await publishedCatalogRows(pool, project)
  return NextResponse.json({ project, cards: catalogPublicCards(rows) }, { headers: { 'Cache-Control': 'no-store', 'X-Olnoo-Catalog-Project': project } })
}

export const GET = withCatalogSchemaGuard(get)
