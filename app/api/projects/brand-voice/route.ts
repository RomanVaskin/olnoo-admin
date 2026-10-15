import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { EMPTY_BRAND_VOICE, getProjectBrandVoice, saveProjectBrandVoice, BrandVoiceError } from '@/lib/project-brand-voice'

/** The project's Brand Profile (target audience, tone & style, verified facts, constraints, preferred CTA). */
export async function GET(req: Request) {
  const projectId = Number(new URL(req.url).searchParams.get('projectId'))
  if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  return NextResponse.json({ voice: (await getProjectBrandVoice(pool, projectId)) ?? EMPTY_BRAND_VOICE })
}

/** Saves the Brand Profile: { projectId, targetAudience, toneStyle, verifiedFacts, constraints, preferredCta }. It never starts any AI work. */
export async function PUT(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = Number(body?.projectId)
  if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  try {
    return NextResponse.json({ voice: await saveProjectBrandVoice(pool, projectId, body) })
  } catch (err) {
    if (err instanceof BrandVoiceError) return NextResponse.json({ error: err.message }, { status: 422 })
    console.error('projects/brand-voice save failed', err)
    return NextResponse.json({ error: 'Не удалось сохранить Brand Profile.' }, { status: 500 })
  }
}
