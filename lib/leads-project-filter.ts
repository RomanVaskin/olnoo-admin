/**
 * Decides how `GET /api/leads` should scope its query for a given `?project=` value.
 *
 * - missing or `"all"` → every project's leads (`kind: 'all'`) — the Admin UI's "All projects" mode.
 * - a slug that resolved to a real `projects.id` → scoped to that one project (`kind: 'one'`).
 * - a slug that did NOT resolve (unknown project, typo) → no leads at all (`kind: 'none'`).
 *
 * The `'none'` case is the fix for a fail-open bug: `resolveProjectId()` returns `null` both for
 * "all"/missing AND for an unknown slug, which a naive `project_id = $1 OR $1 IS NULL` query
 * conflated into "return everything" for an unrecognized slug too — silently leaking every
 * project's leads to whoever passed a bad/typo'd slug. Pulled out as a pure function (same
 * pattern as e.g. `lib/seo-decision-rules.ts`) so this is exercised directly in
 * `lib/leads-project-filter.test.ts` without a database.
 */
export type LeadsProjectFilter =
  | { kind: 'all' }
  | { kind: 'one'; projectId: number }
  | { kind: 'none' }

export function wantsAllProjects(projectParam: string | null): boolean {
  return !projectParam || projectParam === 'all'
}

/**
 * `resolvedProjectId` is the result of calling `resolveProjectId(projectParam)` (or `null` when
 * `wantsAllProjects(projectParam)` is true and the caller skipped resolving it).
 */
export function resolveLeadsProjectFilter(
  projectParam: string | null,
  resolvedProjectId: number | null,
): LeadsProjectFilter {
  if (wantsAllProjects(projectParam)) return { kind: 'all' }
  if (resolvedProjectId) return { kind: 'one', projectId: resolvedProjectId }
  return { kind: 'none' }
}
