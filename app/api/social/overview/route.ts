import { NextResponse } from 'next/server'
import { getSocialOverview } from '@/lib/social-overview'

// Read-only. No POST/PATCH/DELETE here — Social Overview never creates or publishes anything;
// that still only ever happens on the project-scoped Posts/Accounts screens.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  const result = await getSocialOverview(project)
  if (!result) return NextResponse.json({ error: 'unknown project' }, { status: 404 })
  return NextResponse.json(result)
}
