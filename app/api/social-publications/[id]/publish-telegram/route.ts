import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { publishSocialPublicationToTelegram } from '@/lib/social-telegram'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  try {
    const result = await publishSocialPublicationToTelegram(pool, id, project)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.row)
  } catch (err) {
    console.error('social-publications/publish-telegram failed', err)
    return NextResponse.json({ error: 'Could not publish to Telegram. Please try again.' }, { status: 500 })
  }
}
