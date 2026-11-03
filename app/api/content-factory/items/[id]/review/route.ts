import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { claimAiReview, finishAiReview, getItem, hasPassedAiReview } from '@/lib/content-factory-items'
import { reviewContentFactoryItem } from '@/lib/content-factory-review'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  const item = await getItem(pool, projectId, id)
  if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (hasPassedAiReview(item)) return NextResponse.json(item)
  if (!item.generatedText.trim() || !['ready', 'needs_review', 'failed'].includes(item.status) || item.socialPostId) {
    return NextResponse.json({ error: 'This material cannot be reviewed in its current state.' }, { status: 409 })
  }

  const claimed = await claimAiReview(pool, projectId, id)
  if (!claimed) return NextResponse.json({ error: 'The material changed or is already being reviewed. Refresh it and try again.' }, { status: 409 })
  const snapshot = { title: claimed.generatedTitle, text: claimed.generatedText, imageFilename: claimed.imageFilename, claimId: claimed.aiReview?.claimId ?? '' }
  try {
    const review = await reviewContentFactoryItem(pool, claimed)
    const updated = await finishAiReview(pool, projectId, id, snapshot, review)
    if (!updated) return NextResponse.json({ error: 'The material changed during review. Review it again.' }, { status: 409 })
    return NextResponse.json(updated)
  } catch (err) {
    console.error('content-factory review failed', err)
    await finishAiReview(pool, projectId, id, snapshot, {
      status: 'error', passed: false, error: 'AI review failed or returned an invalid result. Repeat the review before publishing.',
    })
    return NextResponse.json({ error: 'AI review failed or returned an invalid result. Publication is blocked.' }, { status: 502 })
  }
}
