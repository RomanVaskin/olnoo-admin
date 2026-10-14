import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { createSocialPost, deleteSocialPost } from '@/lib/social'
import { generateChannelVariants } from '@/lib/social-ai'
import { runSocialAgentTask, type SocialAgentDeps } from '@/lib/social-agent'

// The ONLY place the OLNOO Social AI Agent MVP's two reused functions — createSocialPost
// (lib/social.ts) and generateChannelVariants (lib/social-ai.ts) — are actually called. See
// lib/social-agent.ts's own file-level comment for why its orchestration takes these as an
// injected `SocialAgentDeps` rather than importing them directly (both transitively depend on
// `@/lib/db`, so lib/social-agent.ts itself stays free of `@/` imports and testable under plain
// `node --test`).
//
// No automatic publish of any kind happens anywhere in this file or lib/social-agent.ts — every
// created post is a real social_posts row with status 'draft' and no publish_date, exactly like a
// post a human created by hand through "+ Add" and hasn't touched yet. It only ever becomes
// `ready`/scheduled/published through the EXISTING Social Posts UI, unchanged by this feature.
export async function POST(req: Request) {
  const payload = await req.json().catch(() => null)
  if (!payload || typeof payload.project !== 'string') {
    return NextResponse.json({ error: 'project is required' }, { status: 400 })
  }
  const projectSlug = payload.project
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const task = typeof payload.task === 'string' ? payload.task : ''
  // The client mints this once per logical "run" and resends the SAME value when retrying the
  // SAME attempt (a double click, a network retry) — see lib/social-agent.ts's own comment on
  // claimAgentRun. A missing/blank runId still gets a safe, unique one rather than failing the
  // whole request; only the CLIENT reusing the same value across retries of one attempt matters.
  const runId = typeof payload.runId === 'string' && payload.runId.trim() ? payload.runId.trim() : randomUUID()

  const deps: SocialAgentDeps = {
    createAdaptedDraftPost: async (item) => {
      const variants = await generateChannelVariants(pool, projectId, { topic: item.topic, body: item.body, channels: item.channels })
      const result = await createSocialPost(projectSlug, {
        topic: item.topic,
        body: item.body,
        channels: item.channels,
        telegramText: variants.telegram,
        instagramText: variants.instagram,
        threadsText: variants.threads,
        vkText: variants.vk,
        status: 'draft',
      })
      if ('error' in result) throw new Error(result.error)
      return { id: result.row.id as string, topic: item.topic, channels: item.channels }
    },
    deletePost: async (id) => {
      await deleteSocialPost(id, projectSlug)
    },
  }

  try {
    const result = await runSocialAgentTask(pool, projectId, runId, task, deps)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result)
  } catch (err) {
    console.error('social/agent-task failed', err)
    return NextResponse.json({ error: 'Could not run the AI agent. Please try again.' }, { status: 500 })
  }
}
