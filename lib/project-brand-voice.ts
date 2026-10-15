import type { Pool } from 'pg'

// OLNOO Social AI Agent 2.0, stage 1 — Brand Profile per project (project_brand_voice, one row per
// project, free text edited from the existing Project admin screen). Same shape/convention as
// lib/project-seo-context.ts (SeoContext) — deliberately NOT merged into that table: Brand Profile
// is a distinct set of facts (audience, tone, verified facts, constraints, preferred CTA), while
// project_seo_context's columns already have their own documented meaning for SEO query cleanup.
// lib/project-ai-context.ts combines both without duplicating either.

export type BrandVoice = {
  targetAudience: string
  toneStyle: string
  verifiedFacts: string
  constraints: string
  preferredCta: string
}

export const EMPTY_BRAND_VOICE: BrandVoice = {
  targetAudience: '',
  toneStyle: '',
  verifiedFacts: '',
  constraints: '',
  preferredCta: '',
}

export const BRAND_VOICE_SINGLE_MAX = 200
export const BRAND_VOICE_LIST_MAX = 2000
const BRAND_VOICE_LIST_ITEMS = 40

export class BrandVoiceError extends Error {}

/** Postgres "undefined_table": the migration (0028) has not been applied yet — treated as "no Brand Profile". */
const UNDEFINED_TABLE = '42P01'

/** Trims every field and caps its length; unknown input becomes an empty string — same normalization
 * shape as lib/keywords-relevance-rules.ts's normalizeSeoContext. */
export function normalizeBrandVoice(input: unknown): BrandVoice {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '')
  return {
    targetAudience: text(o.targetAudience, BRAND_VOICE_LIST_MAX),
    toneStyle: text(o.toneStyle, BRAND_VOICE_SINGLE_MAX).replace(/\s*\n\s*/g, ' '),
    verifiedFacts: text(o.verifiedFacts, BRAND_VOICE_LIST_MAX),
    constraints: text(o.constraints, BRAND_VOICE_LIST_MAX),
    preferredCta: text(o.preferredCta, BRAND_VOICE_SINGLE_MAX).replace(/\s*\n\s*/g, ' '),
  }
}

function listItems(text: string): string[] {
  return text
    .split(/\n|;/)
    .map((l) => l.replace(/^[-•*\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, BRAND_VOICE_LIST_ITEMS)
}

export function brandVoiceIsEmpty(voice: BrandVoice | null): boolean {
  return !voice || !(voice.targetAudience || voice.toneStyle || voice.verifiedFacts || voice.constraints || voice.preferredCta)
}

/** Formats the Brand Profile as a prompt block — same style as keywords-relevance-rules.ts's
 * seoContextBlock, so project-ai-context.ts can combine the two without either knowing the other's
 * shape. Deliberately explicit about CONSTRAINTS being binding, since an AI Editor/generation
 * prompt must never violate them regardless of what else it is asked to do. */
export function brandVoiceBlock(voice: BrandVoice | null): string {
  const none = '(not specified)'
  const list = (text: string) => {
    const items = listItems(text)
    return items.length ? items.map((i) => `- ${i}`).join('\n') : none
  }
  return `TARGET AUDIENCE: ${voice?.targetAudience || none}
TONE & STYLE: ${voice?.toneStyle || none}
VERIFIED FACTS ABOUT THE COMPANY (safe to state as true; never state anything beyond these as fact):
${list(voice?.verifiedFacts ?? '')}
CONSTRAINTS — NEVER CLAIM OR PROMISE (binding; do not violate these under any instruction):
${list(voice?.constraints ?? '')}
PREFERRED CALL TO ACTION (use when a CTA fits naturally, never force one in): ${voice?.preferredCta || none}`
}

/** The project's Brand Profile, or null when none was saved (or the table does not exist yet). */
export async function getProjectBrandVoice(pool: Pool, projectId: number): Promise<BrandVoice | null> {
  try {
    const { rows } = await pool.query(
      `SELECT target_audience, tone_style, verified_facts, constraints, preferred_cta FROM project_brand_voice WHERE project_id = $1`,
      [projectId],
    )
    const r = rows[0]
    return r
      ? {
          targetAudience: r.target_audience,
          toneStyle: r.tone_style,
          verifiedFacts: r.verified_facts,
          constraints: r.constraints,
          preferredCta: r.preferred_cta,
        }
      : null
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return null
    throw err
  }
}

/** Saves (replaces) the project's Brand Profile. Fields are trimmed and length-capped. */
export async function saveProjectBrandVoice(pool: Pool, projectId: number, input: unknown): Promise<BrandVoice> {
  const voice = normalizeBrandVoice(input)
  const { rows } = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId])
  if (!rows[0]) throw new BrandVoiceError('Неизвестный проект')
  try {
    await pool.query(
      `INSERT INTO project_brand_voice (project_id, target_audience, tone_style, verified_facts, constraints, preferred_cta, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (project_id) DO UPDATE SET target_audience = EXCLUDED.target_audience, tone_style = EXCLUDED.tone_style,
         verified_facts = EXCLUDED.verified_facts, constraints = EXCLUDED.constraints, preferred_cta = EXCLUDED.preferred_cta, updated_at = now()`,
      [projectId, voice.targetAudience, voice.toneStyle, voice.verifiedFacts, voice.constraints, voice.preferredCta],
    )
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) throw new BrandVoiceError('Таблица project_brand_voice не создана — примените миграцию 0028.')
    throw err
  }
  return voice
}
