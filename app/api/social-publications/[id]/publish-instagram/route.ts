import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { publishSocialPublicationToInstagram } from '@/lib/social-instagram'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  try {
    const result = await publishSocialPublicationToInstagram(pool, id, project)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.row)
  } catch (err) {
    console.error('social-publications/publish-instagram failed', err)
    return NextResponse.json({ error: 'Could not publish to Instagram. Please try again.' }, { status: 500 })
  }
}
