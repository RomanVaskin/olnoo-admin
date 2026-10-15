import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { editSocialPostText, SocialAiEditorError, isEditorAction } from '@/lib/social-ai-editor'
import { AiRouterError } from '@/lib/ai-router'

// OLNOO Social AI Agent 2.0, stage 1 — AI Editor. Proposes an edited version of one post's text;
// never writes to social_posts itself (see lib/social-ai-editor.ts's own comment) — the existing
// post editor applies the proposal to its own local state and only the existing "Save" persists it.
export async function POST(req: Request) {
  const payload = await req.json().catch(() => null)
  if (!payload || typeof payload.project !== 'string') {
    return NextResponse.json({ error: 'project is required' }, { status: 400 })
  }
  const projectId = await resolveProjectId(payload.project)
  if (!projectId) {
    return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  }

  const text = typeof payload.text === 'string' ? payload.text : ''
  const action = payload.action
  if (!isEditorAction(action)) {
    return NextResponse.json({ error: 'a known action is required' }, { status: 400 })
  }
  const customInstruction = typeof payload.customInstruction === 'string' ? payload.customInstruction : ''

  try {
    const edited = await editSocialPostText(pool, projectId, { text, action, customInstruction })
    return NextResponse.json({ text: edited })
  } catch (err) {
    if (err instanceof SocialAiEditorError || err instanceof AiRouterError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('social/ai-edit failed', err)
    return NextResponse.json({ error: 'Could not run the AI Editor. Please try again.' }, { status: 500 })
  }
}
