import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { CONTENT_FACTORY_REVIEW_PROMPT, ContentFactoryReviewError, parseContentFactoryReview, reviewContentFactoryItem } from './content-factory-review.ts'
import { hasPassedAiReview, type ContentFactoryItem } from './content-factory-items.ts'

const item = {
  id: 'item', projectId: 1, sourceId: 'source', externalId: 'post',
  originalUrl: 'https://t.me/source/1', originalText: 'The city approved a new housing plan.', originalImageUrls: [], originalPublishedAt: null,
  status: 'ready', generatedTitle: 'Housing plan', generatedText: 'A city housing plan was approved. The decision may affect local buyers.',
  reviewReason: '', aiReview: null, error: '', socialPostId: null, imageFilename: '', createdAt: '', updatedAt: '',
} satisfies ContentFactoryItem

const low = JSON.stringify({ risk: 'low', passed: true, issues: [], recommendations: [] })

test('independent review asks for all required risk checks and legal uncertainty', () => {
  for (const term of ['verbatim', 'close paraphrase', 'structure', 'quotations', 'attribution', 'source images', 'exclusive', 'prices', 'investment promises', 'jurisdiction', 'licence']) {
    assert.ok(CONTENT_FACTORY_REVIEW_PROMPT.includes(term), term)
  }
  assert.match(CONTENT_FACTORY_REVIEW_PROMPT, /not a legal opinion/i)
})

test('only a valid low-risk decision passes the current title, text and image', () => {
  const review = parseContentFactoryReview(low, item)
  assert.equal(review.status, 'passed')
  assert.equal(hasPassedAiReview({ ...item, aiReview: review }), true)
  assert.equal(hasPassedAiReview({ ...item, generatedText: 'Edited', aiReview: review }), false)
  assert.equal(hasPassedAiReview({ ...item, generatedTitle: 'Edited', aiReview: review }), false)
  assert.equal(hasPassedAiReview({ ...item, imageFilename: 'another.jpg', aiReview: review }), false)
  assert.equal(hasPassedAiReview({ ...item, aiReview: null }), false)
})

test('medium and high risk block publication until a corrected draft is reviewed again', () => {
  for (const risk of ['medium', 'high'] as const) {
    const result = parseContentFactoryReview(JSON.stringify({ risk, passed: true, issues: [{ category: 'copy', detail: 'Similar structure', example: 'Same section order' }], recommendations: ['Rewrite the structure'] }), item)
    assert.equal(result.passed, false)
    assert.equal(hasPassedAiReview({ ...item, aiReview: result }), false)
    assert.equal(result.status, risk === 'high' ? 'blocked' : 'changes_required')
  }
})

test('invalid JSON, missing evidence and schema drift fail closed', () => {
  assert.throws(() => parseContentFactoryReview('not JSON', item), ContentFactoryReviewError)
  assert.throws(() => parseContentFactoryReview(JSON.stringify({ risk: 'medium', passed: false, issues: [], recommendations: [] }), item), ContentFactoryReviewError)
  assert.throws(() => parseContentFactoryReview(JSON.stringify({ risk: 'low', passed: false, issues: [], recommendations: [] }), item), ContentFactoryReviewError)
  assert.throws(() => parseContentFactoryReview(JSON.stringify({ risk: 'low', passed: true, issues: [], recommendations: [], legalVerdict: 'safe' }), item), ContentFactoryReviewError)
})

test('a verbatim passage blocks even when the model says low', () => {
  const copied = { ...item, originalText: 'This is a sufficiently long passage copied word for word from the source publication.', generatedText: 'This is a sufficiently long passage copied word for word from the source publication.' }
  const review = parseContentFactoryReview(low, copied)
  assert.equal(review.risk, 'high')
  assert.equal(review.status, 'blocked')
  assert.ok(review.issues?.some(issue => issue.category === 'verbatim_copy'))
})

test('review sends source, draft and project context through the Router preset without selecting a model', async () => {
  const pool = { query: async (sql: string) => {
    if (sql.includes('FROM projects')) return { rows: [{ name: 'Example', domain: 'example.com' }] }
    if (sql.includes('FROM project_brand_voice')) return { rows: [{ target_audience: 'Buyers', tone_style: 'Measured', verified_facts: '', constraints: '', preferred_cta: '' }] }
    return { rows: [] }
  } } as unknown as Pool
  const originalFetch = globalThis.fetch
  let request: Record<string, unknown> = {}
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    request = JSON.parse(init.body as string)
    return new Response(JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', content: low }))
  }) as typeof fetch
  try {
    const result = await reviewContentFactoryItem(pool, item)
    assert.equal(result.status, 'passed')
    assert.equal(request.service, 'content-factory')
    assert.equal(request.presetTask, 'review')
    assert.equal('provider' in request, false)
    assert.equal('model' in request, false)
    assert.equal('temperature' in request, false)
    const prompt = (request.messages as { content: string }[]).map(message => message.content).join('\n')
    assert.match(prompt, /Buyers/)
    assert.match(prompt, /https:\/\/t.me\/source\/1/)
    assert.match(prompt, /A city housing plan/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
