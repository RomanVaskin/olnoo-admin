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

test('requirement: the system prompt requires citing the source URL', () => {
  assert.match(CONTENT_FACTORY_SYSTEM_PROMPT, /include SOURCE URL itself/i)
  assert.match(CONTENT_FACTORY_SYSTEM_PROMPT, /SOURCE URL is the only source link to keep by default/i)
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
  assert.match(p, /1200–1800 characters in "body" by default, including the title, source URL, and any CTA/i)
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

test('parseGenerationResult: a valid JSON object is parsed, and the source URL is appended if the model omitted it', () => {
  const raw = JSON.stringify({ title: 'Новый проект на побережье', body: 'Полностью независимый текст.', needsReview: false, reviewReason: '' })
  const result = parseGenerationResult(raw, 'Оригинальный текст источника.', 'https://t.me/alexander_realty/101')
  assert.equal(result.title, 'Новый проект на побережье')
  assert.ok(result.body.includes('https://t.me/alexander_realty/101'))
  assert.equal(result.needsReview, false)
})

test('parseGenerationResult: does not duplicate the source URL if the model already included it', () => {
  const raw = JSON.stringify({
    title: 'x',
    body: 'Текст с ссылкой. Источник: https://t.me/alexander_realty/101',
    needsReview: false,
    reviewReason: '',
  })
  const result = parseGenerationResult(raw, 'original', 'https://t.me/alexander_realty/101')
  assert.equal(result.body.split('https://t.me/alexander_realty/101').length - 1, 1)
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
    assert.ok(result.body.includes('https://t.me/alexander_realty/1'))
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
