import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getSettings, saveSettings } from '@/lib/content-factory-settings'

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  return NextResponse.json(await getSettings(pool, projectId))
}

/** Saves the "Автоматизация" settings for one project. Never itself triggers generation or
 * publishing — see lib/content-factory-settings.ts's own comment: `autoPublish`/`mode` here are
 * just stored configuration, read (not acted on automatically) by the current background sweep;
 * see OLNOO_PROJECT_MAP.md for exactly what is and isn't wired to them yet. */
export async function PUT(req: Request) {
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  return NextResponse.json(await saveSettings(pool, projectId, body))
}
