import type { Pool } from 'pg'

// Контент-завод — per-project automation settings ("Автоматизация" screen). Pool-injected, no
// `@/` imports. One row per project (upsert-only); a project with no row yet gets the defaults
// below, which match the task's own safety requirement verbatim: `mode: 'manual'`,
// `autoPublish: false` — nothing in this module ever flips either to an automatic value by
// itself; only an explicit PUT from the Automation screen changes them.

export const CONTENT_FACTORY_MODES = ['manual', 'auto_review', 'auto_publish'] as const
export type ContentFactoryMode = (typeof CONTENT_FACTORY_MODES)[number]

export function isContentFactoryMode(value: unknown): value is ContentFactoryMode {
  return typeof value === 'string' && (CONTENT_FACTORY_MODES as readonly string[]).includes(value)
}

export type ContentFactorySettings = {
  projectId: number
  mode: ContentFactoryMode
  language: string
  allowedTopics: string
  maxPostsPerDay: number
  schedule: string
  requiresApproval: boolean
  autoPublish: boolean
}

const DEFAULTS: Omit<ContentFactorySettings, 'projectId'> = {
  mode: 'manual',
  language: '',
  allowedTopics: '',
  maxPostsPerDay: 3,
  schedule: '',
  requiresApproval: true,
  autoPublish: false,
}

function fromRow(projectId: number, row: Record<string, unknown> | undefined): ContentFactorySettings {
  if (!row) return { projectId, ...DEFAULTS }
  return {
    projectId,
    mode: isContentFactoryMode(row.mode) ? row.mode : DEFAULTS.mode,
    language: (row.language as string) ?? '',
    allowedTopics: (row.allowed_topics as string) ?? '',
    maxPostsPerDay: Number(row.max_posts_per_day) || DEFAULTS.maxPostsPerDay,
    schedule: (row.schedule as string) ?? '',
    requiresApproval: row.requires_approval !== false,
    autoPublish: row.auto_publish === true,
  }
}

export async function getSettings(pool: Pool, projectId: number): Promise<ContentFactorySettings> {
  const { rows } = await pool.query('SELECT * FROM content_factory_settings WHERE project_id = $1', [projectId])
  return fromRow(projectId, rows[0])
}

export async function saveSettings(
  pool: Pool,
  projectId: number,
  patch: Partial<Omit<ContentFactorySettings, 'projectId'>>,
): Promise<ContentFactorySettings> {
  const current = await getSettings(pool, projectId)
  const next: ContentFactorySettings = {
    projectId,
    mode: patch.mode !== undefined && isContentFactoryMode(patch.mode) ? patch.mode : current.mode,
    language: patch.language !== undefined ? patch.language.trim() : current.language,
    allowedTopics: patch.allowedTopics !== undefined ? patch.allowedTopics.trim() : current.allowedTopics,
    maxPostsPerDay: patch.maxPostsPerDay !== undefined ? Math.max(0, Math.floor(patch.maxPostsPerDay)) : current.maxPostsPerDay,
    schedule: patch.schedule !== undefined ? patch.schedule.trim() : current.schedule,
    requiresApproval: patch.requiresApproval !== undefined ? patch.requiresApproval : current.requiresApproval,
    autoPublish: patch.autoPublish !== undefined ? patch.autoPublish : current.autoPublish,
  }

  await pool.query(
    `INSERT INTO content_factory_settings (project_id, mode, language, allowed_topics, max_posts_per_day, schedule, requires_approval, auto_publish)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       language = EXCLUDED.language,
       allowed_topics = EXCLUDED.allowed_topics,
       max_posts_per_day = EXCLUDED.max_posts_per_day,
       schedule = EXCLUDED.schedule,
       requires_approval = EXCLUDED.requires_approval,
       auto_publish = EXCLUDED.auto_publish,
       updated_at = now()`,
    [next.projectId, next.mode, next.language, next.allowedTopics, next.maxPostsPerDay, next.schedule, next.requiresApproval, next.autoPublish],
  )
  return next
}
