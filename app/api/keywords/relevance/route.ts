import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import {
  getRelevanceJob,
  getRelevanceSummary,
  listKeywordRelevance,
  RelevanceError,
  setKeywordRelevance,
  startRelevanceJob,
  viewRelevanceJob,
} from '@/lib/keywords-relevance'
import { isRelevanceStatus } from '@/lib/keywords-relevance-rules'

const PAGE = 100

/**
 * AI relevance cleanup of a project's search queries.
 * GET ?projectId            → counts per status + progress of the latest run;
 * GET ?projectId&list=1     → a page of keywords (status = unclassified | target | …, offset).
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const projectId = Number(params.get('projectId'))
  if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })

  if (params.get('list') === '1') {
    const offset = Math.max(0, Number(params.get('offset')) || 0)
    return NextResponse.json(await listKeywordRelevance(pool, projectId, { status: params.get('status') ?? undefined, limit: PAGE, offset }))
  }
  const job = getRelevanceJob(projectId)
  return NextResponse.json({ summary: await getRelevanceSummary(pool, projectId), job: job ? viewRelevanceJob(job) : null })
}

/**
 * Starts a background cleanup of the not-yet-checked keywords (or returns the run in progress);
 * `resume: true` redoes only the failed batches of a failed run; `requeue: 'disputed'` first puts the
 * AI's uncertain / geo_mismatch keywords, `requeue: 'geo'` only its geo_mismatch ones, `requeue: 'all'` every AI decision (never manual ones) back to «not checked». Answers at once, the UI polls GET.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = Number(body?.projectId)
  if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  try {
    const job = await startRelevanceJob(pool, projectId, {
      resume: body?.resume === true,
      reviewManual: body?.reviewManual === true,
      requeueDisputed: body?.requeue === 'disputed',
      requeueAll: body?.requeue === 'all',
      requeueGeo: body?.requeue === 'geo',
    })
    return NextResponse.json({ job: viewRelevanceJob(job) }, { status: 202 })
  } catch (err) {
    if (err instanceof RelevanceError) return NextResponse.json({ error: err.message }, { status: 422 })
    console.error('keywords/relevance start failed', err)
    return NextResponse.json({ error: 'Не удалось запустить проверку запросов.' }, { status: 500 })
  }
}

/** A person's decision on one keyword: { projectId, keywordId, status } — `status: null` resets it to «not checked». */
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = Number(body?.projectId)
  const keywordId = Number(body?.keywordId)
  const status = body?.status ?? null
  if (!Number.isInteger(projectId) || !Number.isInteger(keywordId)) {
    return NextResponse.json({ error: 'projectId and keywordId are required' }, { status: 400 })
  }
  if (status !== null && !isRelevanceStatus(status)) return NextResponse.json({ error: 'Неизвестный статус релевантности.' }, { status: 400 })
  try {
    await setKeywordRelevance(pool, { projectId, keywordId, status })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof RelevanceError) return NextResponse.json({ error: err.message }, { status: 422 })
    console.error('keywords/relevance override failed', err)
    return NextResponse.json({ error: 'Не удалось сохранить решение.' }, { status: 500 })
  }
}
