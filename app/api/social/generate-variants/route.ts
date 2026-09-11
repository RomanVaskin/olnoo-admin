import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { generateChannelVariants, SocialAiError } from '@/lib/social-ai'
import { AiRouterError } from '@/lib/ai-router'

export async function POST(req: Request) {
  const payload = await req.json().catch(() => null)
  if (!payload || typeof payload.project !== 'string') {
    return NextResponse.json({ error: 'project is required' }, { status: 400 })
  }

  const projectId = await resolveProjectId(payload.project)
  if (!projectId) {
    return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  }

  const topic = typeof payload.topic === 'string' ? payload.topic : ''
  const body = typeof payload.body === 'string' ? payload.body : ''
  const channels = Array.isArray(payload.channels) ? payload.channels : []

  try {
    const variants = await generateChannelVariants(pool, projectId, { topic, body, channels })
    return NextResponse.json({ variants })
  } catch (err) {
    if (err instanceof SocialAiError || err instanceof AiRouterError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('social/generate-variants failed', err)
    return NextResponse.json({ error: 'Could not generate variants. Please try again.' }, { status: 500 })
  }
}
