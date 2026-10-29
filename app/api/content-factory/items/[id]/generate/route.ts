import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem, setItemStatus, setGeneratedContent, canGenerate } from '@/lib/content-factory-items'
import { generateContentFactoryArticle, ContentFactoryGenerateError } from '@/lib/content-factory-generate'
import { AiRouterError } from '@/lib/ai-router'

/**
 * "Сгенерировать материал" / "Перегенерировать" — one AI Router call per request (see
 * lib/content-factory-generate.ts). Sets status to 'processing' before the call so a slow
 * request shows as busy rather than stuck on 'new'/'ready'; a failure records the ORIGINAL
 * item's own 'failed' status with the error, never losing the item's source text (the AI call
 * never receives a mutable reference to it, same posture as every other AI call in this app) —
 * and the item can simply be generated again afterwards (canGenerate allows retrying from
 * 'failed'). Never surfaces a raw/internal error (e.g. a Postgres error) to the client.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const item = await getItem(pool, projectId, id)
  if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!canGenerate(item.status)) {
    return NextResponse.json({ error: `Cannot generate from status "${item.status}".` }, { status: 409 })
  }

  await setItemStatus(pool, projectId, id, { status: 'processing' })

  try {
    const generated = await generateContentFactoryArticle(pool, projectId, { sourceText: item.originalText, sourceUrl: item.originalUrl })
    const status = generated.needsReview ? 'needs_review' : 'ready'
    const updated = await setGeneratedContent(pool, projectId, id, {
      title: generated.title,
      text: generated.body,
      status,
      reviewReason: generated.reviewReason,
    })
    return NextResponse.json(updated)
  } catch (err) {
    if (err instanceof ContentFactoryGenerateError || err instanceof AiRouterError) {
      await setItemStatus(pool, projectId, id, { status: 'failed', error: err.message })
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('content-factory/items generate failed', err)
    await setItemStatus(pool, projectId, id, { status: 'failed', error: 'Generation failed.' })
    return NextResponse.json({ error: 'Could not generate the article. Please try again.' }, { status: 500 })
  }
}
