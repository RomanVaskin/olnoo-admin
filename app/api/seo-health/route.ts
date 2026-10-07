import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { checkProjectHealth, type ProjectHealth } from '@/lib/seo-health'
import { listProjects } from '@/lib/projects-registry'
import { compareIssues, readLastResult, readLastResults, saveLastResult, type Recheck } from '@/lib/seo-health-store'

type Row = ProjectHealth & { repository: string | null; recheck?: Recheck }

/**
 * GET /api/seo-health            live check of every active project → saved as the project's last result → returned.
 * GET /api/seo-health?projectId= live check (recheck) of ONE project; the response also carries a transient `recheck`
 *                                (resolved / stillFailing / newIssues vs the previously saved result; not stored).
 * GET /api/seo-health?mode=last  the saved last results of active projects, no network fetches (all active projects; a never-checked one comes as { notChecked: true, projectId, projectName, domain, repository }).
 * Failure policy: a site that is down / a missing sitemap is a valid SEO result (saved, 200). A database failure (reading the
 * registry, reading or saving the result) is NOT an SEO issue: it answers 500 { error, code: 'storage_failed' }.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const projectId = params.get('projectId')

  try {
    if (params.get('mode') === 'last') return NextResponse.json(await readLastResults(pool))
    return await liveCheck(projectId)
  } catch (err) {
    console.error('seo-health storage failure', err)
    return NextResponse.json({ error: 'Database error: the Technical SEO result could not be read or saved', code: 'storage_failed' }, { status: 500 })
  }
}

async function liveCheck(projectId: string | null) {
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
    rows.map(async (p): Promise<Row> => {
      const previous = projectId ? await readLastResult(pool, p.id) : null
      const health = await check(p)
      await saveLastResult(pool, health)
      return { ...health, repository: p.repository, ...(previous ? { recheck: compareIssues(previous.issues, health.issues) } : {}) }
    }),
  )

  return NextResponse.json(results)
}

/** Never rejects: an unexpected check failure becomes a synthetic (saved) result with a `check_failed` issue. */
async function check(p: Awaited<ReturnType<typeof listProjects>>[number]): Promise<ProjectHealth> {
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
}
