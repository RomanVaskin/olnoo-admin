import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { checkProjectHealth, type ProjectHealth } from '@/lib/seo-health'
import { listProjects } from '@/lib/projects-registry'

export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get('projectId')

  // Active projects with a domain, from the shared registry — archived projects never take part in «Check all».
  const all = (await listProjects(pool)).filter((p) => p.domain.trim() !== '')
  const rows = projectId ? all.filter((p) => String(p.id) === projectId) : all

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
