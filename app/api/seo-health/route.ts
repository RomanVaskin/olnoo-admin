import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { checkProjectHealth, type ProjectHealth } from '@/lib/seo-health'

export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get('projectId')

  const { rows } = await pool.query(
    projectId
      ? 'SELECT id, name, domain, sitemap_url FROM projects WHERE id = $1 ORDER BY id ASC'
      : "SELECT id, name, domain, sitemap_url FROM projects WHERE btrim(domain) <> '' ORDER BY id ASC",
    projectId ? [projectId] : [],
  )

  if (projectId && rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // A single project's fetch failure (site down, sitemap timeout, ...) must not abort the batch —
  // checkProjectHealth already resolves each check to an 'Error' status rather than rejecting, so
  // this only guards against something unexpected (e.g. a bad row) taking the whole request down.
  const results = await Promise.all(
    rows.map(async (p): Promise<ProjectHealth> => {
      try {
        return await checkProjectHealth(p)
      } catch {
        return {
          projectId: p.id,
          projectName: p.name,
          domain: p.domain,
          sitemapUrl: null,
          site: { status: 'Error', httpStatus: null },
          robots: { status: 'Warning', httpStatus: null, disallowAll: false },
          sitemap: { status: 'Error', httpStatus: null, urlCount: null },
          pages: [],
          pagesTruncated: false,
          issues: [{ severity: 'ERROR', code: 'check_failed', message: 'The check itself failed' }],
          errors: 1,
          warnings: 0,
          overall: 'Error',
          checkedAt: new Date().toISOString(),
        }
      }
    }),
  )

  return NextResponse.json(results)
}
