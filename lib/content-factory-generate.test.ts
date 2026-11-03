import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  CONTENT_FACTORY_SYSTEM_PROMPT,
  buildContentFactoryPrompt,
  parseGenerationResult,
  hasVerbatimOverlap,
  generateContentFactoryArticle,
  ContentFactoryGenerateError,
} from './content-factory-generate.ts'
import { saveProjectBrandVoice } from './project-brand-voice.ts'

// --- Pure: prompt / parser ---

test('requirement: the prompt asks for an independent analytical article with its own structure and a practical takeaway', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  assert.match(p, /first identify the concrete facts/i)
  assert.match(p, /never a repost, translation, summary, or light paraphrase/i)
  assert.match(p, /new title, opening, and structure/i)
  assert.match(p, /why it matters to the target audience/i)
  assert.match(p, /practical takeaway that follows from the supported facts/i)
})

test('editorial method selects one useful format and avoids mechanical rewrites', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  for (const phrase of [
    'Select ONE format',
    'news (event and relevance)',
    'expert explainer (one practical question)',
    'property overview (specific offer',
    'Choose only the facts necessary',
    'Outline by reader value',
    'not independent findings',
    'self-check every paragraph against the source',
    "do not mechanically recreate the source's feature list"
  ]) assert.ok(p.includes(phrase), phrase)
})

test('generation separates facts and supported figures from source framing before choosing a new analytical angle', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  assert.match(p, /separating reported facts and exact figures from the source's opinions, framing, and wording/i)
  assert.match(p, /Choose your own analytical angle based on what matters to the target audience/i)
  assert.match(p, /not around the source's paragraph order/i)
  assert.match(p, /Do not copy the source's headline, sequence of points, distinctive phrasing, or sentence-by-sentence argument even with synonyms/i)
  assert.match(p, /Preserve exact figures when verified by PROJECT CONTEXT/i)
  assert.match(p, /if they appear only in SOURCE TEXT, keep them exact but explicitly attributed and unconfirmed under rule 6/i)
  assert.match(p, /Do not round, alter, or invent figures/i)
})

test('requirement: the prompt separates interpretation from evidence and forbids invented claims', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  assert.match(p, /never invent facts, numbers, prices, statistics, laws, outcomes, or claims/i)
  assert.match(p, /distinguish source-reported facts from your interpretation/i)
  assert.match(p, /if the facts do not support a specific consequence or recommendation/i)
})

test('requirement: the prompt flags unconfirmed price, yield, statistics, legislation, and investment claims', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  assert.match(p, /unconfirmed PRICE, YIELD\/PROFITABILITY, STATISTIC, LEGISLATION claim, or INVESTMENT recommendation/i)
  assert.match(p, /"needsReview": true with a specific "reviewReason"/i)
  assert.match(p, /do not derive new figures or forecasts/i)
})

test('requirement: the prompt removes source promotion while using the project Brand Profile', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  assert.match(p, /remove the SOURCE channel's advertising, self-promotion, promotional links, and calls to action/i)
  assert.match(p, /do not carry over its contact details or sales pitch/i)
  assert.match(p, /use PROJECT CONTEXT's Brand Profile/i)
  assert.match(p, /never force one or copy the source's CTA/i)
})

test('requirement: the system prompt forbids reusing a source image', () => {
  assert.ok(/do not propose.*reusing any image/i.test(CONTENT_FACTORY_SYSTEM_PROMPT))
})

test('requirement: ordinary posts omit the source channel while attribution cases require review', () => {
  assert.match(CONTENT_FACTORY_SYSTEM_PROMPT, /SOURCE URL is internal provenance/i)
  assert.match(CONTENT_FACTORY_SYSTEM_PROMPT, /direct quote, exclusive information/i)
  assert.doesNotMatch(CONTENT_FACTORY_SYSTEM_PROMPT, /include SOURCE URL itself/i)
})

test('requirement: the prompt flags substantial copied wording for manual review', () => {
  assert.match(CONTENT_FACTORY_SYSTEM_PROMPT, /substantially copies the source's wording, set "needsReview": true/i)
})

test('Telegram format: body contains the visible title, short paragraphs, emoji subheadings, and bullets', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  assert.match(p, /publisher sends "body" alone, so put the exact "title" as its first line/i)
  assert.match(p, /short paragraphs/i)
  assert.match(p, /emoji-led subheadings/i)
  assert.match(p, /plain-text bullets \(•\)/i)
  assert.match(p, /practical takeaway easy to find/i)
})

test('Telegram format: default length and emoji density yield to the project Brand Profile', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  assert.match(p, /1200–1800 characters in "body" by default, including the title and any CTA/i)
  assert.match(p, /different length if the project's Brand Profile specifies one/i)
  assert.match(p, /shorter useful post rather than padding it/i)
  assert.match(p, /3–6 relevant emojis across the whole post by default/i)
  assert.match(p, /rather than in every paragraph/i)
  assert.match(p, /Brand Profile calls for fewer or none, follow it/i)
  assert.doesNotMatch(p, /AURELMAR/i)
})

test('Telegram format: plain text avoids markup that the current publisher would send literally', () => {
  const p = CONTENT_FACTORY_SYSTEM_PROMPT
  assert.match(p, /publisher sends plain text without a formatting parse mode/i)
  assert.match(p, /do not use raw Markdown or HTML for bold, headings, links, or lists/i)
  assert.match(p, /markers would appear literally/i)
})

test('buildContentFactoryPrompt includes source text, source URL, and the project context block', () => {
  const prompt = buildContentFactoryPrompt({ sourceText: 'Original post text', sourceUrl: 'https://t.me/x/1', contextBlock: 'CTX-BLOCK' })
  assert.ok(prompt.includes('Original post text'))
  assert.ok(prompt.includes('https://t.me/x/1'))
  assert.ok(prompt.includes('CTX-BLOCK'))
})

test('parseGenerationResult: an independent article does not acquire the source URL', () => {
  const raw = JSON.stringify({ title: 'Новый проект на побережье', body: 'Полностью независимый текст.', needsReview: false, reviewReason: '' })
  const result = parseGenerationResult(raw, 'Оригинальный текст источника.', 'https://t.me/alexander_realty/101')
  assert.equal(result.title, 'Новый проект на побережье')
  assert.equal(result.body, 'Полностью независимый текст.')
  assert.equal(result.needsReview, false)
})

test('parseGenerationResult: strips only the source channel and its promotion, keeping other links', () => {
  const raw = JSON.stringify({
    title: 'Рынок недвижимости @alexander_realty',
    body: 'Рынок недвижимости @alexander_realty\nНовая информация в https://example.com/report, https://t.me/other_channel/2 и https://t.me/alexander_realty_news/2. Подробнее: https://t.me/alexander_realty/101\nЧитайте @alexander_realty\nИсточник: https://t.me/alexander_realty/101\nИсточник: https://t.me/alexander_realty/101, документ https://example.org/alexander_realty/report\nВывод для читателя.',
    needsReview: false,
    reviewReason: '',
  })
  const result = parseGenerationResult(raw, 'original', 'https://t.me/alexander_realty/101')
  assert.doesNotMatch(result.title + result.body, /@alexander_realty(?![a-z_])|t\.me\/alexander_realty(?![a-z_])/i)
  assert.match(result.body, /^Рынок недвижимости$/m)
  assert.doesNotMatch(result.body, /Источник:|Читайте @/i)
  assert.doesNotMatch(result.body, /Подробнее:\s*(?:\n|$)/i)
  assert.match(result.body, /https:\/\/example.com\/report/)
  assert.match(result.body, /https:\/\/t.me\/other_channel\/2/)
  assert.match(result.body, /https:\/\/t.me\/alexander_realty_news\/2/)
  assert.match(result.body, /https:\/\/example.org\/alexander_realty\/report/)
  assert.match(result.body, /Вывод для читателя/)
  assert.equal(result.needsReview, false)
})

test('parseGenerationResult: direct quotes and exclusives keep attribution for manual review', () => {
  const sourceUrl = 'https://t.me/alexander_realty/101'
  const quote = parseGenerationResult(JSON.stringify({ title: 'Анализ', body: `«Подтверждённая цитата автора» — ${sourceUrl}`, needsReview: false, reviewReason: '' }), 'Оригинальный текст.', sourceUrl)
  assert.equal(quote.needsReview, true)
  assert.match(quote.reviewReason, /quote/i)
  assert.match(quote.body, /alexander_realty/)
  const exclusive = parseGenerationResult(JSON.stringify({ title: 'Анализ', body: `По данным ${sourceUrl}, есть новая информация.`, needsReview: false, reviewReason: '' }), 'Эксклюзив: сведения от автора.', sourceUrl)
  assert.equal(exclusive.needsReview, true)
  assert.match(exclusive.reviewReason, /exclusive/i)
  assert.match(exclusive.body, /alexander_realty/)
})

test('parseGenerationResult: a model-flagged attribution is preserved', () => {
  const sourceUrl = 'https://t.me/alexander_realty/101'
  const result = parseGenerationResult(JSON.stringify({ title: 'Анализ', body: `Сведения: ${sourceUrl}`, needsReview: true, reviewReason: 'Check source attribution rights.' }), 'Original', sourceUrl)
  assert.equal(result.needsReview, true)
  assert.equal(result.reviewReason, 'Check source attribution rights.')
  assert.match(result.body, /alexander_realty/)
})

test('parseGenerationResult: a source-only draft is never treated as ready', () => {
  const sourceUrl = 'https://t.me/alexander_realty/101'
  const raw = JSON.stringify({ title: '@alexander_realty', body: `Источник: ${sourceUrl}`, needsReview: false, reviewReason: '' })
  const result = parseGenerationResult(raw, 'Оригинальный текст.', sourceUrl)
  assert.equal(result.needsReview, true)
  assert.match(result.reviewReason, /source promotion/i)
})

test('parseGenerationResult: strips a markdown code fence before parsing', () => {
  const raw = '```json\n' + JSON.stringify({ title: 't', body: 'b', needsReview: false, reviewReason: '' }) + '\n```'
  const result = parseGenerationResult(raw, 'original', '')
  assert.equal(result.title, 't')
})

test('parseGenerationResult: missing title or body throws ContentFactoryGenerateError', () => {
  assert.throws(() => parseGenerationResult(JSON.stringify({ title: '', body: 'b', needsReview: false, reviewReason: '' }), 'o', ''), ContentFactoryGenerateError)
  assert.throws(() => parseGenerationResult(JSON.stringify({ title: 't', body: '', needsReview: false, reviewReason: '' }), 'o', ''), ContentFactoryGenerateError)
})

test('parseGenerationResult: not valid JSON at all throws ContentFactoryGenerateError', () => {
  assert.throws(() => parseGenerationResult('not json at all', 'o', ''), ContentFactoryGenerateError)
})

test('requirement: a non-boolean needsReview defaults to true (manual review required), never silently false', () => {
  const raw = JSON.stringify({ title: 't', body: 'A fully independent body with no overlap at all here.', reviewReason: '' })
  const result = parseGenerationResult(raw, 'Some unrelated original text about something else entirely different.', '')
  assert.equal(result.needsReview, true)
  assert.ok(result.reviewReason.length > 0)
})

test('requirement: needsReview as a string is rejected and forced to true, never coerced', () => {
  const raw = JSON.stringify({ title: 't', body: 'A fully independent body with no overlap at all here.', needsReview: 'false', reviewReason: '' })
  const result = parseGenerationResult(raw, 'Some unrelated original text about something else entirely different.', '')
  assert.equal(result.needsReview, true)
})

test('requirement: a genuine false needsReview from the model is respected when there is no verbatim overlap', () => {
  const raw = JSON.stringify({ title: 't', body: 'A fully independent rewrite with zero overlap whatsoever in it.', needsReview: false, reviewReason: '' })
  const result = parseGenerationResult(raw, 'Some unrelated original text about something else entirely different content here.', '')
  assert.equal(result.needsReview, false)
})

// --- hasVerbatimOverlap ---

test('hasVerbatimOverlap: true when a long run of text is shared verbatim', () => {
  const original = 'Новая вилла с панорамным видом на море расположена в элитном районе Аланьи рядом с центром города.'
  const generated = `Вот что известно: ${original} Подробнее на сайте.`
  assert.equal(hasVerbatimOverlap(generated, original), true)
})

test('hasVerbatimOverlap: false for a genuinely independent rewrite covering the same topic', () => {
  const original = 'Новая вилла с панорамным видом на море расположена в элитном районе Аланьи рядом с центром города.'
  const generated = 'В Аланье появился ещё один проект премиальной недвижимости — апартаменты с видом на побережье, по данным партнёрского канала.'
  assert.equal(hasVerbatimOverlap(generated, original), false)
})

test('hasVerbatimOverlap: forces needsReview true in parseGenerationResult even when the model claims false', () => {
  const original = 'Новая вилла с панорамным видом на море расположена в элитном районе Аланьи рядом с центром города сегодня.'
  const raw = JSON.stringify({ title: 't', body: original, needsReview: false, reviewReason: '' })
  const result = parseGenerationResult(raw, original, '')
  assert.equal(result.needsReview, true)
  assert.ok(/verbatim/i.test(result.reviewReason))
})

test('Content Factory uses the text preset while retaining Brand Profile, JSON parsing and review flag', async () => {
  const pool = { query: async (sql: string) => {
    if (sql.includes('FROM projects')) return { rows: [{ name: 'Example', domain: 'example.com' }] }
    if (sql.includes('FROM project_brand_voice')) return { rows: [{ target_audience: 'Readers', tone_style: 'Measured', verified_facts: '', constraints: '', preferred_cta: '' }] }
    return { rows: [] }
  } } as unknown as Pool
  const originalFetch = globalThis.fetch
  let sent: Record<string, unknown> = {}
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string)
    return new Response(JSON.stringify({ provider: 'deepseek', content: JSON.stringify({ title: 'Analysis', body: 'Independent text', needsReview: true, reviewReason: 'Check a claim' }) }))
  }) as typeof fetch
  try {
    const result = await generateContentFactoryArticle(pool, 1, { sourceText: 'Original report', sourceUrl: 'https://t.me/source/1' })
    assert.equal(sent.service, 'content-factory')
    assert.equal('provider' in sent, false)
    assert.equal('model' in sent, false)
    const prompt = (sent.messages as Array<{ content: string }>).map((message) => message.content).join('\n')
    assert.match(prompt, /Measured/)
    assert.match(prompt, /Original report/)
    assert.deepEqual(result, { title: 'Analysis', body: 'Independent text', needsReview: true, reviewReason: 'Check a claim' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

// --- DB + AI Router integration (skipped without a reachable Postgres) ---

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(t: import('node:test').TestContext, fn: (pool: Pool, makeProject: (name: string) => Promise<number>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT project_id FROM project_brand_voice LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the project_brand_voice schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientIds: number[] = []
  const makeProject = async (name: string) => {
    const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_content_factory__' || clock_timestamp()::text) RETURNING id`)).rows[0].id as number
    clientIds.push(clientId)
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    return (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        name,
        `${slug}.example`,
        slug,
      ])
    ).rows[0].id as number
  }
  try {
    await fn(pool, makeProject)
  } finally {
    for (const clientId of clientIds) {
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    }
    await pool.end()
  }
}

async function withFetch<T>(handler: (url: string, init?: RequestInit) => Response | Error, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const out = handler(String(url), init)
    if (out instanceof Error) throw out
    return out
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function aiRouterOk(content: string): Response {
  return new Response(JSON.stringify({ id: 'r1', requestId: 'req1', provider: 'openai', model: 'gpt', content }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('generateContentFactoryArticle: returns the AI Router\'s parsed article', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const raw = JSON.stringify({ title: 'Новый проект на побережье', body: 'Полностью независимый пересказ фактов.', needsReview: false, reviewReason: '' })
    const result = await withFetch(() => aiRouterOk(raw), () =>
      generateContentFactoryArticle(pool, projectId, { sourceText: 'Оригинальный пост Александра.', sourceUrl: 'https://t.me/alexander_realty/1' }),
    )
    assert.equal(result.title, 'Новый проект на побережье')
    assert.doesNotMatch(result.body, /alexander_realty/)
  })
})

test('generateContentFactoryArticle: empty source text is refused before any AI Router call', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    let called = false
    await assert.rejects(
      () =>
        withFetch(
          () => {
            called = true
            return aiRouterOk('{}')
          },
          () => generateContentFactoryArticle(pool, projectId, { sourceText: '   ', sourceUrl: '' }),
        ),
      ContentFactoryGenerateError,
    )
    assert.equal(called, false)
  })
})

test('requirement: Brand Profile is applied — the prompt sent to the AI Router carries the project\'s own tone/constraints', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    await saveProjectBrandVoice(pool, projectId, {
      toneStyle: 'Professional, international, analytical, no hype',
      constraints: 'Never promise guaranteed returns',
    })
    let sentPrompt = ''
    await withFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        sentPrompt = body.messages.map((m: { content: string }) => m.content).join('\n')
        return aiRouterOk(JSON.stringify({ title: 't', body: 'b', needsReview: false, reviewReason: '' }))
      },
      () => generateContentFactoryArticle(pool, projectId, { sourceText: 'source text', sourceUrl: '' }),
    )
    assert.ok(sentPrompt.includes('Professional, international, analytical, no hype'))
    assert.ok(sentPrompt.includes('Never promise guaranteed returns'))
  })
})

test('requirement: project isolation — generating for project A never sends project B\'s Brand Profile', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectA = await makeProject('AURELMAR')
    const projectB = await makeProject('DriveSet')
    await saveProjectBrandVoice(pool, projectA, { toneStyle: 'For AURELMAR only' })
    await saveProjectBrandVoice(pool, projectB, { toneStyle: 'For DriveSet only' })

    let sentPrompt = ''
    await withFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        sentPrompt = body.messages.map((m: { content: string }) => m.content).join('\n')
        return aiRouterOk(JSON.stringify({ title: 't', body: 'b', needsReview: false, reviewReason: '' }))
      },
      () => generateContentFactoryArticle(pool, projectA, { sourceText: 'source text', sourceUrl: '' }),
    )
    assert.ok(sentPrompt.includes('For AURELMAR only'))
    assert.ok(!sentPrompt.includes('For DriveSet only'))
  })
})

test('requirement: an AI Router failure never loses the original source text — the caller receives a thrown error', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    await assert.rejects(
      () =>
        withFetch(
          () => new Response(JSON.stringify({ error: 'upstream failure' }), { status: 500 }),
          () => generateContentFactoryArticle(pool, projectId, { sourceText: 'Some real source text.', sourceUrl: '' }),
        ),
      /AI Router|ContentFactoryGenerateError/,
    )
  })
})
