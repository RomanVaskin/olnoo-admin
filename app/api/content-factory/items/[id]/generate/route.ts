import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem, setItemStatus, setGeneratedContent, canGenerate } from '@/lib/content-factory-items'
import { generateContentFactoryArticle, reviseContentFactoryArticle, ContentFactoryGenerateError } from '@/lib/content-factory-generate'
import { AiRouterError } from '@/lib/ai-router'

/**
 * "Сгенерировать материал" / "Перегенерировать" — two sequential AI Router calls per request (see
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
  if (item.processingMode === 'copy') return NextResponse.json({ error: 'Partner copy does not use AI text generation.' }, { status: 409 })
  if (item.socialPostId || item.enSocialPostId || item.enPublishClaimed) return NextResponse.json({ error: 'A linked or publishing post cannot be regenerated.' }, { status: 409 })
  if (!canGenerate(item.status)) {
    return NextResponse.json({ error: `Cannot generate from status "${item.status}".` }, { status: 409 })
  }

  await setItemStatus(pool, projectId, id, { status: 'processing' })

  try {
    const flaggedIssues = item.aiReview?.issues ?? []
    const isTargetedRevision = !!item.generatedText.trim() && flaggedIssues.length > 0
      && (item.aiReview?.risk === 'high' || item.aiReview?.risk === 'medium' || item.aiReview?.quality?.passed === false || item.aiReview?.passed === false)
      && item.aiReview?.reviewedTitle === item.generatedTitle
      && item.aiReview?.reviewedText === item.generatedText
    const generated = isTargetedRevision
      ? await reviseContentFactoryArticle(pool, projectId, {
          sourceText: item.originalText, sourceUrl: item.originalUrl,
          title: item.generatedTitle, body: item.generatedText,
          issues: flaggedIssues, recommendations: item.aiReview?.recommendations ?? [],
        })
      : await generateContentFactoryArticle(pool, projectId, { sourceText: item.originalText, sourceUrl: item.originalUrl })
    const status = generated.needsReview ? 'needs_review' : 'ready'
    const updated = await setGeneratedContent(pool, projectId, id, {
      title: generated.title,
      text: generated.body,
      status,
      reviewReason: generated.reviewReason,
    })
    return updated ? NextResponse.json(updated) : NextResponse.json({ error: 'The material changed during generation. Reload it.' }, { status: 409 })
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
