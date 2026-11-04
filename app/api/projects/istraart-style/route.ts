import { withCatalogSchemaGuard } from '@/lib/catalog-schema'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getIstraArtStyle, saveIstraArtStyle } from '@/lib/istraart-style-store'
import { validateIstraArtStyle } from '@/lib/istraart-style'
const headers = { 'Cache-Control': 'no-store' }
async function get(req: Request) {
  if (new URL(req.url).searchParams.get('project') !== 'istraart') return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  const prompt = await getIstraArtStyle(pool)
  return prompt === null ? NextResponse.json({ error: 'Not found' }, { status: 404, headers }) : NextResponse.json({ prompt }, { headers })
}
async function put(req: Request) {
  const origin = req.headers.get('origin')
  if (origin && origin !== new URL(req.url).origin) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers })
  if (new URL(req.url).searchParams.get('project') !== 'istraart') return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  const body = await req.json().catch(() => null)
  try { if (!body || Object.keys(body).length !== 1) throw new Error('Укажите один промпт.'); validateIstraArtStyle(body.prompt) }
  catch (err) { return NextResponse.json({ error: (err as Error).message }, { status: 422, headers }) }
  const prompt = await saveIstraArtStyle(pool, body.prompt)
  return prompt === null ? NextResponse.json({ error: 'Not found' }, { status: 404, headers }) : NextResponse.json({ prompt }, { headers })
}

export const GET = withCatalogSchemaGuard(get)
export const PUT = withCatalogSchemaGuard(put)
