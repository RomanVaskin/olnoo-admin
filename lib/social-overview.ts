import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { resolveLeadsProjectFilter, wantsAllProjects } from '@/lib/leads-project-filter'
import { summarizeAccountStatusCounts } from '@/lib/social-overview-metrics'

// Social Overview — read-only aggregation across Social's existing three tables
// (social_accounts, social_posts, social_publications), for exactly one project or for every
// project at once ("All projects"), by the same project.slug mechanism every other screen in this
// app already uses. No new table, no migration, no new service: every number here is a plain
// COUNT/GROUP BY against tables that already exist.
//
// Project scoping deliberately reuses lib/leads-project-filter.ts's `wantsAllProjects` and
// `resolveLeadsProjectFilter` as-is (not Social-specific despite the file's name — the decision
// they encode, "an unresolved slug must return NO data, never silently fall back to 'all'", is
// exactly the one this screen also needs) rather than re-implementing the same slug-resolution
// logic a second time. This is the only cross-project read in the Social module; it does not
// change any other Social route's behavior.

export type SocialOverviewResult = {
  metrics: {
    /** social_publications.status = 'published' — a post that actually went out on that
     * platform. Not time-bounded (no period filter exists yet for this screen; see note below). */
    published: number
    /** social_posts.status = 'ready' AND publish_date <> '' — a post that will be picked up by
     * the scheduler (lib/social-scheduler.ts) once its publish_date arrives, whether or not that
     * moment has already passed (an overdue post is still "scheduled", just waiting on the next
     * sweep — this screen does not re-derive isPublishDue, which would make the same post flicker
     * between "scheduled" and not depending on exactly when this page is loaded). */
    scheduled: number
    /** social_accounts, grouped by its own `status` column. `error` here is a LOST CONNECTION
     * (the account's own VK/Telegram token/channel check failed — see
     * lib/social-accounts-vk-connection.ts / lib/social-accounts-telegram-connection.ts), never
     * combined with publicationErrors below. */
    accounts: ReturnType<typeof summarizeAccountStatusCounts>
    /** social_publications.status = 'failed' — one specific post failed to publish on one
     * specific platform. A distinct count from accounts.error on purpose (see module comment in
     * lib/social-overview-metrics.ts). */
    publicationErrors: number
  }
  recentPublications: Array<{
    id: string
    projectSlug: string
    projectName: string
    postTopic: string
    platform: string
    status: string
    externalUrl: string
    error: string
    publishedAt: string | null
    updatedAt: string
  }>
}

const RECENT_PUBLICATIONS_LIMIT = 10

/** `projectColumn` lets the same scoping decision apply to a query that joins multiple tables
 * (recentPublications qualifies it as `sp.project_id`) as well as single-table COUNT queries
 * (the default, unqualified `project_id`). */
function scopeClause(
  filter: { kind: 'all' } | { kind: 'one'; projectId: number },
  projectColumn = 'project_id',
): { clause: string; params: number[] } {
  if (filter.kind === 'one') return { clause: `${projectColumn} = $1`, params: [filter.projectId] }
  return { clause: 'TRUE', params: [] }
}

/**
 * Builds the Social Overview for `projectParam` — a real project slug, `"all"`/missing for every
 * project, or an unknown slug. Returns `null` for an unknown slug: this screen is read-only (no
 * create/publish action exists here at all), but still must never silently show "all projects"
 * data for a slug that doesn't resolve to a real project — same fail-closed rule `GET /api/leads`
 * already enforces, reused rather than re-decided here.
 */
export async function getSocialOverview(projectParam: string | null): Promise<SocialOverviewResult | null> {
  const resolvedProjectId = wantsAllProjects(projectParam) ? null : await resolveProjectId(projectParam)
  const filter = resolveLeadsProjectFilter(projectParam, resolvedProjectId)
  if (filter.kind === 'none') return null

  const published = scopeClause(filter)
  const { rows: publishedRows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM social_publications WHERE ${published.clause} AND status = 'published'`,
    published.params,
  )

  const scheduled = scopeClause(filter)
  const { rows: scheduledRows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM social_posts WHERE ${scheduled.clause} AND status = 'ready' AND publish_date <> ''`,
    scheduled.params,
  )

  const accountsScope = scopeClause(filter)
  const { rows: accountStatusRows } = await pool.query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int AS count FROM social_accounts WHERE ${accountsScope.clause} GROUP BY status`,
    accountsScope.params,
  )

  const publicationErrorsScope = scopeClause(filter)
  const { rows: publicationErrorRows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM social_publications WHERE ${publicationErrorsScope.clause} AND status = 'failed'`,
    publicationErrorsScope.params,
  )

  const recentScope = scopeClause(filter, 'sp.project_id')
  const { rows: recentRows } = await pool.query(
    `SELECT sp.id, p.slug AS project_slug, p.name AS project_name, po.topic AS post_topic,
            sp.platform, sp.status, sp.external_url, sp.error, sp.published_at, sp.updated_at
     FROM social_publications sp
     JOIN projects p ON p.id = sp.project_id
     JOIN social_posts po ON po.id = sp.social_post_id
     WHERE ${recentScope.clause}
     ORDER BY sp.updated_at DESC
     LIMIT ${RECENT_PUBLICATIONS_LIMIT}`,
    recentScope.params,
  )

  return {
    metrics: {
      published: publishedRows[0]?.count ?? 0,
      scheduled: scheduledRows[0]?.count ?? 0,
      accounts: summarizeAccountStatusCounts(accountStatusRows),
      publicationErrors: publicationErrorRows[0]?.count ?? 0,
    },
    recentPublications: recentRows.map((row) => ({
      id: row.id as string,
      projectSlug: row.project_slug as string,
      projectName: row.project_name as string,
      postTopic: row.post_topic as string,
      platform: row.platform as string,
      status: row.status as string,
      externalUrl: (row.external_url as string) ?? '',
      error: (row.error as string) ?? '',
      publishedAt: (row.published_at as string | null) ?? null,
      updatedAt: row.updated_at as string,
    })),
  }
}
