import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { EMPTY_SEO_CONTEXT } from '@/lib/keywords-relevance-rules'
import { getProjectSeoContext, saveProjectSeoContext, SeoContextError } from '@/lib/project-seo-context'

/** The project's explicit SEO context (business type, region, services, planned directions, what is not offered). */
export async function GET(req: Request) {
  const projectId = Number(new URL(req.url).searchParams.get('projectId'))
  if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  return NextResponse.json({ context: (await getProjectSeoContext(pool, projectId)) ?? EMPTY_SEO_CONTEXT })
}

/** Saves the context: { projectId, businessType, region, services, plannedServices, excluded }. It never starts any AI work. */
export async function PUT(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = Number(body?.projectId)
  if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  try {
    return NextResponse.json({ context: await saveProjectSeoContext(pool, projectId, body) })
  } catch (err) {
    if (err instanceof SeoContextError) return NextResponse.json({ error: err.message }, { status: 422 })
    console.error('projects/seo-context save failed', err)
    return NextResponse.json({ error: 'Не удалось сохранить контекст проекта.' }, { status: 500 })
  }
}
