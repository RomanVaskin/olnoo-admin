import type { Pool } from 'pg'
import { getProjectBrandVoice, brandVoiceBlock, type BrandVoice } from './project-brand-voice.ts'
import { getProjectSeoContext } from './project-seo-context.ts'
import { seoContextBlock, type SeoContext } from './keywords-relevance-rules.ts'

// OLNOO Social AI Agent 2.0, stage 1 — the ONE reusable project AI context builder. Combines the
// project's own name/domain, its Brand Profile (lib/project-brand-voice.ts), and the existing,
// already-verified SEO context (lib/project-seo-context.ts) into a single prompt block, without
// duplicating either source's data or logic — both are read through their own existing
// get*/…Block functions, never re-queried or re-normalized here.
//
// Used by Social Agent planning (lib/social-agent.ts), per-channel adaptation
// (lib/social-ai.ts's generateChannelVariants), and the new AI Editor (lib/social-ai-editor.ts),
// replacing each one's previous ad-hoc `${name} (${domain})` project context string. Deliberately
// free of any Social/SEO/Ads-specific knowledge — a future SEO or Ads prompt can reuse
// `buildProjectAiContext`/`projectAiContextBlock` as-is; this file does not decide how a caller's
// prompt is structured or worded. No `@/` imports (pool is injected, same convention as
// lib/project-seo-context.ts and lib/social-agent.ts), so this is directly testable under this
// project's plain `node --test`.

export type ProjectAiContext = {
  projectId: number
  name: string
  domain: string
  brandVoice: BrandVoice | null
  seoContext: SeoContext | null
}

/** Reads everything needed for one project's AI context in parallel. Never throws for a project
 * with no Brand Profile or no SEO context yet — both are optional and render as "(not specified)"
 * in the block below; only an unknown `projectId` leaves `name`/`domain` empty. */
export async function buildProjectAiContext(pool: Pool, projectId: number): Promise<ProjectAiContext> {
  const [projectRows, brandVoice, seoContext] = await Promise.all([
    pool.query<{ name: string; domain: string }>('SELECT name, domain FROM projects WHERE id = $1', [projectId]),
    getProjectBrandVoice(pool, projectId),
    getProjectSeoContext(pool, projectId),
  ])
  const project = projectRows.rows[0]
  return { projectId, name: project?.name ?? '', domain: project?.domain ?? '', brandVoice, seoContext }
}

/**
 * Formats the full context as one prompt block. This is what every caller should send as
 * "PROJECT CONTEXT" instead of a bare `${name} (${domain})` — it carries the project's identity,
 * its Brand Profile (so generation/editing never need a project-specific hardcoded persona), and
 * its verified SEO facts (so generation never has to guess a business's services/region/exclusions).
 */
export function projectAiContextBlock(ctx: ProjectAiContext): string {
  const identity = ctx.name ? (ctx.domain ? `${ctx.name} (${ctx.domain})` : ctx.name) : ctx.domain || '(unknown project)'
  return `PROJECT: ${identity}

BRAND PROFILE:
${brandVoiceBlock(ctx.brandVoice)}

VERIFIED SEO CONTEXT:
${seoContextBlock(ctx.seoContext)}`
}
