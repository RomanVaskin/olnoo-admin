import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { CONTENT_FACTORY_REVIEW_PROMPT, ContentFactoryReviewError, parseContentFactoryReview, reviewContentFactoryItem } from './content-factory-review.ts'
import { hasPassedAiReview, type ContentFactoryItem } from './content-factory-items.ts'

const item = {
  id: 'item', projectId: 1, sourceId: 'source', externalId: 'post',
  originalUrl: 'https://t.me/source/1', originalText: 'The city approved a new housing plan.', originalImageUrls: [], originalPublishedAt: null,
  processingMode: 'ai', copyPermissionConfirmed: false, copyApprovedAt: null,
  status: 'ready', generatedTitle: 'Housing plan', generatedText: 'A city housing plan was approved. The decision may affect local buyers.',
  reviewReason: '', aiReview: null, error: '', socialPostId: null, imageFilename: '', createdAt: '', updatedAt: '',
} satisfies ContentFactoryItem

const qualityPass = { passed: true, issues: [], recommendations: [] }
const low = JSON.stringify({ risk: 'low', passed: true, issues: [], recommendations: [], quality: qualityPass })

test('independent review asks for all required risk checks and legal uncertainty', () => {
  for (const term of ['verbatim', 'close paraphrase', 'structure', 'quotations', 'attribution', 'source images', 'exclusive', 'prices', 'investment promises', 'jurisdiction', 'licence']) {
    assert.ok(CONTENT_FACTORY_REVIEW_PROMPT.includes(term), term)
  }
  assert.match(CONTENT_FACTORY_REVIEW_PROMPT, /not a legal opinion/i)
})

test('review uses the publication language and distinguishes factual overlap from copied expression', () => {
  const p = CONTENT_FACTORY_REVIEW_PROMPT
  assert.match(p, /language of the finished draft \(Russian for a Russian publication\)/i)
  assert.match(p, /issue category, detail, example, and recommendation/i)
  assert.match(p, /Commonly available facts, topics, and accurately repeated supported figures are not themselves copied creative expression/i)
  assert.match(p, /do not assign high risk solely because the draft covers the same topic or uses the same statistics/i)
  assert.match(p, /actual similarity of expression, organization, and unique creative elements/i)
  assert.match(p, /cite the matching passages or structural pattern/i)
  assert.match(p, /Separately verify whether each figure is supported and correctly qualified/i)
  assert.match(p, /quotations, authorship, exclusive claims, attribution/i)
  assert.match(p, /unsupported facts, numbers, prices, yields, investment promises/i)
})

test('review calibration separates common listing facts from copied creative expression', () => {
  const p = CONTENT_FACTORY_REVIEW_PROMPT
  for (const phrase of [
    'separate copyrighted expression from facts',
    'Property names, floor, area, location, prices',
    'Conventional ordering',
    'quote the specific matching passages',
    'the advertisement states X',
    'Require evidence in each copying issue',
    'deterministic verbatim guard stays mandatory'
  ]) assert.ok(p.includes(phrase), phrase)
})

test('quality is checked independently of copyright risk, including every substantial criterion', () => {
  const p = CONTENT_FACTORY_REVIEW_PROMPT
  for (const phrase of ['central idea and conclusion', 'all substantial points, arguments, examples, exact figures, conditions and practical recommendations', 'helpful sections, numbering and lists', 'shallow list', 'quality.passed=false', 'even if copyright risk is low', 'specific missing or weakened source passage']) {
    assert.ok(p.includes(phrase), phrase)
  }
})

test('review detects flattened presentation and formulaic caveats without weakening fact checks', () => {
  const p = CONTENT_FACTORY_REVIEW_PROMPT
  for (const phrase of [
    'helpful sections, numbering and lists',
    'headline, opening, logical flow, short paragraphs, readability, expressiveness and practical value',
    'dry fact sheet',
    'less clear and engaging than a strong original',
    'repetitive bureaucratic phrases',
    'clear qualification of material unverified claims',
    'necessary attribution for quotations or exclusive information',
    'which good sections should stay unchanged',
  ]) assert.ok(p.includes(phrase), phrase)
  assert.doesNotMatch(p, /AURELMAR|Georgia|Cyprus|Potamos/i)
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

test('medium review permits publication with visible issues; high blocks publication', () => {
  const issues = [{ category: 'copy', detail: 'Similar structure', example: 'Same section order' }]
  const medium = parseContentFactoryReview(JSON.stringify({ risk: 'medium', passed: true, issues, recommendations: ['Rewrite the structure'], quality: qualityPass }), item)
  assert.equal(medium.passed, true)
  assert.equal(medium.status, 'passed')
  assert.equal(medium.risk, 'medium')
  assert.equal(medium.issues?.length, 1)
  assert.equal(hasPassedAiReview({ ...item, aiReview: medium }), true)
  assert.equal(hasPassedAiReview({ ...item, generatedText: 'Changed', aiReview: medium }), false)
  const high = parseContentFactoryReview(JSON.stringify({ risk: 'high', passed: true, issues, recommendations: ['Rewrite the structure'], quality: qualityPass }), item)
  assert.equal(high.passed, false)
  assert.equal(high.status, 'blocked')
  assert.equal(hasPassedAiReview({ ...item, aiReview: high }), false)
})

test('a shallow four-criterion hotel post fails quality even with low copyright risk', () => {
  const hotel = { ...item,
    originalText: 'Гостиничную недвижимость в Грузии оценивают по четырём критериям: проверка девелопера и его завершённых проектов; конкурентоспособность отеля и загрузка района; цена и реальная экономика с расходами; договор управления, комиссии и обязанности сторон.',
    generatedText: 'Проверьте девелопера, отель, цену и договор.',
  }
  const quality = { passed: false, issues: [
    { category: 'missing_arguments', detail: 'Не раскрыты расходы и реальная экономика', example: 'В источнике есть расходы; в посте только «цена».' },
    { category: 'missing_advice', detail: 'Нет анализа комиссий и обязанностей по договору', example: 'В посте только «договор».' },
  ], recommendations: ['Раскрыть расходы и условия договора, сохранив остальные удачные фрагменты.'] }
  const review = parseContentFactoryReview(JSON.stringify({ risk: 'low', passed: true, issues: [], recommendations: [], quality }), hotel)
  assert.equal(review.risk, 'low')
  assert.equal(review.quality?.passed, false)
  assert.equal(review.passed, false)
  assert.equal(review.status, 'changes_required')
  assert.equal(hasPassedAiReview({ ...hotel, aiReview: review }), false)
  assert.ok(review.issues?.some((issue) => issue.category === 'quality:missing_arguments'))
  assert.ok(review.recommendations?.some((recommendation) => recommendation.includes('Раскрыть расходы')))
})

test('critical factual or image-rights blocker overrides low/medium risk', () => {
  const issues = [{ category: 'image_rights', detail: 'Source image reused without permission', example: 'The cover matches the source photo.' }]
  const review = parseContentFactoryReview(JSON.stringify({ risk: 'medium', passed: false, issues, recommendations: ['Replace the image'], quality: qualityPass }), item)
  assert.equal(review.risk, 'medium')
  assert.equal(review.passed, false)
  assert.equal(review.status, 'blocked')
  assert.equal(hasPassedAiReview({ ...item, aiReview: review }), false)
})

test('invalid JSON, missing evidence and schema drift fail closed', () => {
  assert.throws(() => parseContentFactoryReview('not JSON', item), ContentFactoryReviewError)
  assert.throws(() => parseContentFactoryReview(JSON.stringify({ risk: 'medium', passed: false, issues: [], recommendations: [] }), item), ContentFactoryReviewError)
  assert.throws(() => parseContentFactoryReview(JSON.stringify({ risk: 'low', passed: false, issues: [], recommendations: [] }), item), ContentFactoryReviewError)
  assert.throws(() => parseContentFactoryReview(JSON.stringify({ risk: 'low', passed: true, issues: [], recommendations: [], legalVerdict: 'safe' }), item), ContentFactoryReviewError)
  assert.throws(() => parseContentFactoryReview(JSON.stringify({ risk: 'low', passed: true, issues: [], recommendations: [] }), item), ContentFactoryReviewError)
  assert.throws(() => parseContentFactoryReview(JSON.stringify({ risk: 'low', passed: true, issues: [], recommendations: [], quality: { passed: false, issues: [], recommendations: [] } }), item), ContentFactoryReviewError)
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


test('review prompt permits medium and blocks high while preserving concrete evidence', () => {
  assert.match(CONTENT_FACTORY_REVIEW_PROMPT, /Medium copyright risk: publishing may also proceed/i)
  assert.match(CONTENT_FACTORY_REVIEW_PROMPT, /High copyright risk blocks publication/i)
  assert.match(CONTENT_FACTORY_REVIEW_PROMPT, /Distinguish independent reuse of unprotected facts/i)
})
