import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { fetchSitemapUrls } from '@/lib/sitemap'
import { fetchPageMeta } from '@/lib/html-extract'
import { internalFetcher } from '@/lib/internal-origin'

const CONCURRENCY = 5

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = body?.projectId

  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }

  let projectRes
  try {
    projectRes = await pool.query('SELECT id, sitemap_url, internal_base_url FROM projects WHERE id = $1', [projectId])
  } catch (err) {
    // Migration 0015 not applied yet: sync keeps using the public URLs, as before.
    if ((err as { code?: string }).code !== '42703') throw err
    projectRes = await pool.query('SELECT id, sitemap_url FROM projects WHERE id = $1', [projectId])
  }
  const project = projectRes.rows[0]
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // A site on the same server is read through its internal base URL (see lib/internal-origin.ts); null = public.
  const routing = internalFetcher(project.sitemap_url, project.internal_base_url)

  let urls: string[]
  try {
    urls = await fetchSitemapUrls(project.sitemap_url, {}, routing)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error('pages/sync: sitemap fetch failed', detail)
    return NextResponse.json({ error: `Failed to fetch sitemap: ${detail}` }, { status: 502 })
  }

  let upserted = 0
  let failed = 0
  const queue = [...urls]

  async function worker() {
    while (queue.length) {
      const url = queue.shift()!
      const meta = await fetchPageMeta(url, {}, routing)
      if (!meta) {
        failed++
        continue
      }
      await pool.query(
        `
        INSERT INTO pages (project_id, url, title, h1, description, locale, status, last_seen_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'Live', now(), now())
        ON CONFLICT (project_id, url)
        DO UPDATE SET
          title = EXCLUDED.title,
          h1 = EXCLUDED.h1,
          description = EXCLUDED.description,
          locale = EXCLUDED.locale,
          last_seen_at = now(),
          updated_at = now()
        `,
        [projectId, url, meta.title, meta.h1, meta.description, meta.locale],
      )
      upserted++
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) || 1 }, worker))

  await pool.query(`UPDATE projects SET last_sync_at = now(), status = 'Synced' WHERE id = $1`, [
    projectId,
  ])

  return NextResponse.json({ found: urls.length, upserted, failed })
}
