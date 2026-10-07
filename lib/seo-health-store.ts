// Technical SEO closed loop (step B): the LAST check of a project is stored on `projects` (no history table), and a recheck is
// compared with the previous stored result by issue identity. Pure SQL helpers over an injectable `db` + one pure compare
// function (no `@/` imports), so they run under `node --test`.
import type { Issue, ProjectHealth } from './seo-health.ts'
import { ACTIVE_PROJECT_SQL, type Queryable } from './projects-registry.ts'

// ---- recheck comparison (pure) ----------------------------------------------------------------------------------------

/** Issue identity = code + URL (project-level issue: code + empty URL). The message text is NOT part of it. */
export const issueKey = (i: Pick<Issue, 'code' | 'url'>) => `${i.code}|${i.url ?? ''}`

export type Recheck = { resolved: Issue[]; stillFailing: Issue[]; newIssues: Issue[] }

/** previous issues vs new issues: resolved = was, now gone (previous issue); stillFailing = was and is (current issue); newIssues = first seen now. */
export function compareIssues(previous: readonly Issue[], current: readonly Issue[]): Recheck {
  const prev = new Map<string, Issue>()
  for (const i of previous) if (!prev.has(issueKey(i))) prev.set(issueKey(i), i)
  const cur = new Map<string, Issue>()
  for (const i of current) if (!cur.has(issueKey(i))) cur.set(issueKey(i), i)
  return {
    resolved: [...prev].filter(([k]) => !cur.has(k)).map(([, i]) => i),
    stillFailing: [...cur].filter(([k]) => prev.has(k)).map(([, i]) => i),
    newIssues: [...cur].filter(([k]) => !prev.has(k)).map(([, i]) => i),
  }
}

// ---- storage -----------------------------------------------------------------------------------------------------------

/** Stored JSON from the DB → a ProjectHealth, or null when absent / not an object with an issues array. */
function asHealth(value: unknown): ProjectHealth | null {
  const v = typeof value === 'string' ? (() => { try { return JSON.parse(value) } catch { return null } })() : value
  return v && typeof v === 'object' && Array.isArray((v as ProjectHealth).issues) ? (v as ProjectHealth) : null
}

/** Overwrites the project's last result (the whole JSON + its checkedAt). A DB error propagates: it is NOT an SEO issue. */
export async function saveLastResult(db: Queryable, health: ProjectHealth): Promise<void> {
  await db.query('UPDATE projects SET seo_health_last_result = $1::jsonb, seo_health_checked_at = $2 WHERE id = $3', [JSON.stringify(health), health.checkedAt, health.projectId])
}

export async function readLastResult(db: Queryable, projectId: number): Promise<ProjectHealth | null> {
  const { rows } = await db.query('SELECT seo_health_last_result FROM projects WHERE id = $1', [projectId])
  return asHealth(rows[0]?.seo_health_last_result)
}

/** An active project that has never been checked: no result at all (never a fake OK/Warning/Error). */
export type NotChecked = { notChecked: true; projectId: number; projectName: string; domain: string; repository: string | null }
export type LastRow = (ProjectHealth & { repository: string | null; notChecked?: false }) | NotChecked

/** ALL active projects with a domain (archived never take part), no network: the saved result, or `notChecked` when there is none. */
export async function readLastResults(db: Queryable): Promise<LastRow[]> {
  const { rows } = await db.query(
    `SELECT pr.id, pr.name, pr.domain, pr.repository, pr.seo_health_last_result FROM projects pr
      WHERE ${ACTIVE_PROJECT_SQL} AND pr.domain <> ''
      ORDER BY pr.created_at ASC, pr.id ASC`,
  )
  return rows.map((r): LastRow => {
    const repository = (r.repository as string | null) ?? null
    const h = asHealth(r.seo_health_last_result)
    return h ? { ...h, repository } : { notChecked: true, projectId: r.id as number, projectName: r.name as string, domain: r.domain as string, repository }
  })
}
