import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  QUALITY_CATEGORIES,
  QUALITY_GATE_SYSTEM_PROMPT,
  buildQualityGatePrompt,
  parseQualityGateResult,
  runQualityGate,
  QualityGateError,
} from './social-quality-gate.ts'
import { saveProjectBrandVoice } from './project-brand-voice.ts'
import { isEditorResultStillValid } from './social-ai-editor-staleness.ts'

// --- Pure: buildQualityGatePrompt / parseQualityGateResult ---

test('requirement: the system prompt never hardcodes OLNOO (or any other fixed brand) as the subject', () => {
  assert.ok(!QUALITY_GATE_SYSTEM_PROMPT.includes('OLNOO'))
})

test('requirement: the system prompt covers all seven criteria from the task, in order', () => {
  const p = QUALITY_GATE_SYSTEM_PROMPT
  assert.ok(/specificity and practical usefulness/i.test(p))
  assert.ok(/factual reliability/i.test(p))
  assert.ok(/brand profile/i.test(p))
  assert.ok(/structure and readability/i.test(p))
  assert.ok(/repetition and generic ai-sounding clich/i.test(p))
  assert.ok(/fit for the selected platforms/i.test(p))
  assert.ok(/call to action/i.test(p))
})

test('requirement: the prompt explicitly forbids calling something false just because it is absent from context', () => {
  assert.ok(/never claim a statement is false merely because it is absent/i.test(QUALITY_GATE_SYSTEM_PROMPT))
  assert.ok(QUALITY_GATE_SYSTEM_PROMPT.includes('needsVerification'))
})

test('requirement: the prompt does not require a CTA in every post', () => {
  assert.ok(/not required to have a cta/i.test(QUALITY_GATE_SYSTEM_PROMPT))
  assert.ok(/never itself a finding/i.test(QUALITY_GATE_SYSTEM_PROMPT))
})

test('requirement: the prompt caps findings at 5', () => {
  assert.ok(/at most 5 findings/i.test(QUALITY_GATE_SYSTEM_PROMPT))
})

test('buildQualityGatePrompt includes TEXT, PLATFORMS, and the project context block', () => {
  const prompt = buildQualityGatePrompt({ text: 'Hello world', channels: ['telegram', 'vk'], contextBlock: 'CTX-BLOCK' })
  assert.ok(prompt.includes('Hello world'))
  assert.ok(prompt.includes('telegram, vk'))
  assert.ok(prompt.includes('CTX-BLOCK'))
})

test('buildQualityGatePrompt states explicitly when no platform is selected yet', () => {
  const prompt = buildQualityGatePrompt({ text: 'x', channels: [], contextBlock: '' })
  assert.ok(prompt.includes('(none selected yet)'))
})

test('parseQualityGateResult: a valid JSON object is parsed as-is', () => {
  const raw = JSON.stringify({
    summary: 'Decent post, one factual gap.',
    findings: [
      {
        category: 'factuality',
        excerpt: 'снижает расходы на 40%',
        explanation: 'This figure is not confirmed by the project context.',
        recommendation: 'Confirm the figure against verified facts, or remove the specific number.',
        needsVerification: true,
      },
    ],
  })
  const originalText = 'Наш сервис снижает расходы на 40% для большинства клиентов.'
  const result = parseQualityGateResult(raw, originalText)
  assert.equal(result.summary, 'Decent post, one factual gap.')
  assert.equal(result.findings.length, 1)
  assert.deepEqual(result.findings[0], {
    category: 'factuality',
    excerpt: 'снижает расходы на 40%',
    explanation: 'This figure is not confirmed by the project context.',
    recommendation: 'Confirm the figure against verified facts, or remove the specific number.',
    needsVerification: true,
  })
})

test('parseQualityGateResult: strips a markdown code fence before parsing', () => {
  const raw = '```json\n' + JSON.stringify({ summary: 'Looks good.', findings: [] }) + '\n```'
  const result = parseQualityGateResult(raw, 'anything')
  assert.equal(result.summary, 'Looks good.')
  assert.equal(result.findings.length, 0)
})

test('parseQualityGateResult: a clean post with zero findings is a valid result, not an error', () => {
  const result = parseQualityGateResult(JSON.stringify({ summary: 'No issues found.', findings: [] }), 'anything')
  assert.equal(result.findings.length, 0)
})

test('parseQualityGateResult: not valid JSON at all throws QualityGateError', () => {
  assert.throws(() => parseQualityGateResult('not json at all', 'anything'), QualityGateError)
})

test('parseQualityGateResult: a JSON array (not an object) throws QualityGateError', () => {
  assert.throws(() => parseQualityGateResult(JSON.stringify([{ summary: 'x' }]), 'anything'), QualityGateError)
})

test('parseQualityGateResult: a stray object before/after the JSON (model commentary) is recovered via the { ... } fallback', () => {
  const raw = `Here is the review:\n${JSON.stringify({ summary: 'ok', findings: [] })}\nLet me know if you want more detail.`
  const result = parseQualityGateResult(raw, 'anything')
  assert.equal(result.summary, 'ok')
})

test('parseQualityGateResult: no usable summary AND no findings throws QualityGateError', () => {
  assert.throws(() => parseQualityGateResult(JSON.stringify({ summary: '', findings: [] }), 'anything'), QualityGateError)
})

test('requirement: a finding with an unknown category is dropped, never invented/kept', () => {
  const raw = JSON.stringify({
    summary: 'x',
    findings: [
      { category: 'tone_of_voice', excerpt: 'some excerpt', explanation: 'x', recommendation: 'y', needsVerification: false },
      { category: 'structure', excerpt: 'some excerpt', explanation: 'x', recommendation: 'y', needsVerification: false },
    ],
  })
  const result = parseQualityGateResult(raw, 'Original post text containing some excerpt verbatim.')
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].category, 'structure')
})

test('requirement: a finding missing excerpt/explanation/recommendation is dropped, never defaulted to empty strings', () => {
  const originalText = 'Original post text containing e verbatim.'
  const raw = JSON.stringify({
    summary: 'x',
    findings: [
      { category: 'structure', excerpt: '', explanation: 'x', recommendation: 'y', needsVerification: false },
      { category: 'structure', excerpt: 'e', explanation: '', recommendation: 'y', needsVerification: false },
      { category: 'structure', excerpt: 'e', explanation: 'x', recommendation: '', needsVerification: false },
      { category: 'structure', excerpt: 'e', explanation: 'x', recommendation: 'y', needsVerification: false },
    ],
  })
  const result = parseQualityGateResult(raw, originalText)
  assert.equal(result.findings.length, 1)
})

test('requirement: findings are capped at 5 even if the model returns more', () => {
  const excerpts = Array.from({ length: 12 }, (_, i) => `excerpt ${i}`)
  const raw = JSON.stringify({
    summary: 'x',
    findings: excerpts.map((excerpt) => ({
      category: 'structure',
      excerpt,
      explanation: 'x',
      recommendation: 'y',
      needsVerification: false,
    })),
  })
  // The original text literally contains every excerpt the model returned, so the cap (not the new
  // verbatim-excerpt check) is what's being exercised here.
  const result = parseQualityGateResult(raw, excerpts.join(' — '))
  assert.equal(result.findings.length, 5)
})

test('requirement: an overly long string in any field is clipped, not rejected or passed through unbounded', () => {
  const huge = 'a'.repeat(5000)
  const raw = JSON.stringify({
    summary: huge,
    findings: [{ category: 'structure', excerpt: huge, explanation: huge, recommendation: huge, needsVerification: false }],
  })
  const result = parseQualityGateResult(raw, huge)
  assert.ok(result.summary.length < 5000)
  assert.ok(result.findings[0].excerpt.length < 5000)
  assert.ok(result.findings[0].explanation.length < 5000)
  assert.ok(result.findings[0].recommendation.length < 5000)
})

test('requirement: needsVerification is only ever true when the model explicitly says so — never inferred', () => {
  const raw = JSON.stringify({
    summary: 'x',
    findings: [{ category: 'factuality', excerpt: 'claim', explanation: 'x', recommendation: 'y', needsVerification: false }],
  })
  const result = parseQualityGateResult(raw, 'Original text with the claim in it.')
  assert.equal(result.findings[0].needsVerification, false)
})

// --- Regression: excerpt must be a real, verbatim substring of the checked text ---

test('requirement: a finding whose excerpt is not a verbatim substring of the checked text is rejected, never kept', () => {
  const raw = JSON.stringify({
    summary: 'x',
    findings: [
      // Fabricated/paraphrased — not actually present in the original text.
      { category: 'factuality', excerpt: 'something the model invented', explanation: 'x', recommendation: 'y', needsVerification: false },
      // A real verbatim quote from the original text.
      { category: 'structure', excerpt: 'real post text', explanation: 'x', recommendation: 'y', needsVerification: false },
    ],
  })
  const result = parseQualityGateResult(raw, 'This is the real post text, nothing more.')
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].category, 'structure')
})

test('requirement: an excerpt that is merely a paraphrase (not a literal substring) is rejected even if closely related', () => {
  const raw = JSON.stringify({
    summary: 'x',
    findings: [{ category: 'specificity', excerpt: 'helps businesses grow faster', explanation: 'x', recommendation: 'y', needsVerification: false }],
  })
  // The original text says "helps businesses grow" — "faster" was never there.
  const result = parseQualityGateResult(raw, 'AI helps businesses grow across every industry.')
  assert.equal(result.findings.length, 0)
})

test('requirement: an empty findings array survives untouched when the original text is checked for every excerpt', () => {
  const result = parseQualityGateResult(JSON.stringify({ summary: 'Looks good, no issues.', findings: [] }), 'Some real post text.')
  assert.equal(result.findings.length, 0)
  assert.equal(result.summary, 'Looks good, no issues.')
})

// --- Regression: needsVerification must be a genuine boolean — a wrong type is rejected, never
// silently coerced to false (a non-boolean "needsVerification" previously became `false`, which
// would wrongly let an unverifiable claim be reported as a confirmed falsehood). ---

test('requirement: needsVerification missing entirely is rejected — the finding is dropped, not defaulted to false', () => {
  const raw = JSON.stringify({
    summary: 'x',
    findings: [{ category: 'factuality', excerpt: 'claim', explanation: 'x', recommendation: 'y' }],
  })
  const result = parseQualityGateResult(raw, 'Original text with the claim in it.')
  assert.equal(result.findings.length, 0)
})

test('requirement: needsVerification as a string ("true") is rejected, never coerced to a boolean', () => {
  const raw = JSON.stringify({
    summary: 'x',
    findings: [{ category: 'factuality', excerpt: 'claim', explanation: 'x', recommendation: 'y', needsVerification: 'true' }],
  })
  const result = parseQualityGateResult(raw, 'Original text with the claim in it.')
  assert.equal(result.findings.length, 0)
})

test('requirement: needsVerification as a number or null is rejected, never silently treated as false', () => {
  const raw = JSON.stringify({
    summary: 'x',
    findings: [
      { category: 'factuality', excerpt: 'claim one', explanation: 'x', recommendation: 'y', needsVerification: 1 },
      { category: 'factuality', excerpt: 'claim two', explanation: 'x', recommendation: 'y', needsVerification: null },
      { category: 'factuality', excerpt: 'claim three', explanation: 'x', recommendation: 'y', needsVerification: true },
    ],
  })
  const result = parseQualityGateResult(raw, 'Text with claim one, claim two and claim three.')
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].excerpt, 'claim three')
  assert.equal(result.findings[0].needsVerification, true)
})

test('QUALITY_CATEGORIES covers all seven criteria named in the task', () => {
  assert.deepEqual(
    [...QUALITY_CATEGORIES].sort(),
    ['brand_profile', 'cta', 'factuality', 'platform_fit', 'repetition_cliches', 'specificity', 'structure'].sort(),
  )
})

// --- Staleness: Quality Gate results share the exact guard the AI Editor already uses and tests
// (lib/social-ai-editor-staleness.ts) — these cases exist to prove the SAME function behaves
// correctly for a Quality Gate snapshot, not to duplicate its own test suite. ---

test('requirement: a Quality Gate result is still valid when post and text are unchanged since the request was fired', () => {
  const requested = { postId: 'post-1', text: 'Original content' }
  const current = { postId: 'post-1', text: 'Original content' }
  assert.equal(isEditorResultStillValid(requested, current), true)
})

test('requirement: a Quality Gate result is stale once the user edits Content after the request was fired', () => {
  const requested = { postId: 'post-1', text: 'Original content' }
  const current = { postId: 'post-1', text: 'Original content, edited since the check ran' }
  assert.equal(isEditorResultStillValid(requested, current), false)
})

test('requirement: a Quality Gate result is stale once the user switches to a different post', () => {
  const requested = { postId: 'post-1', text: 'Original content' }
  const current = { postId: 'post-2', text: 'Original content' }
  assert.equal(isEditorResultStillValid(requested, current), false)
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
    const clientId = (
      await pool.query(`INSERT INTO clients (name) VALUES ('__test_quality_gate__' || clock_timestamp()::text) RETURNING id`)
    ).rows[0].id as number
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

/** Scripted global fetch for the AI Router call (same approach as lib/social-ai-editor.test.ts). */
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

function aiRouterHttpError(status = 500): Response {
  return new Response(JSON.stringify({ error: 'upstream failure' }), { status })
}

/** Wraps a real Pool to record every query's SQL text, so a test can assert runQualityGate never
 * issues a write statement — it is read-only by construction (only buildProjectAiContext's own
 * SELECTs), and this proves it rather than just asserting it in a comment. */
function withQueryLog(pool: Pool): { pool: Pool; queries: string[] } {
  const queries: string[] = []
  const wrapped = {
    query: (text: unknown, params?: unknown[]) => {
      if (typeof text === 'string') queries.push(text)
      return pool.query(text as string, params)
    },
  } as unknown as Pool
  return { pool: wrapped, queries }
}

test('runQualityGate: returns the AI Router\'s (parsed) review', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    const raw = JSON.stringify({
      summary: 'Vague and repetitive.',
      findings: [
        {
          category: 'specificity',
          excerpt: 'помогает бизнесу расти',
          explanation: 'Слишком общее утверждение без конкретики.',
          recommendation: 'Укажите конкретный результат или сценарий использования.',
          needsVerification: false,
        },
      ],
    })
    const result = await withFetch(() => aiRouterOk(raw), () => runQualityGate(pool, projectId, { text: 'ИИ помогает бизнесу расти', channels: ['telegram'] }))
    assert.equal(result.summary, 'Vague and repetitive.')
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].category, 'specificity')
  })
})

test('runQualityGate: empty text is refused before any AI Router call', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    let fetchCalled = false
    await assert.rejects(
      () =>
        withFetch(
          () => {
            fetchCalled = true
            return aiRouterOk('{}')
          },
          () => runQualityGate(pool, projectId, { text: '   ', channels: ['telegram'] }),
        ),
      QualityGateError,
    )
    assert.equal(fetchCalled, false)
  })
})

test('requirement: an AI Router failure never loses or mutates the original text — the caller receives a thrown error', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    await assert.rejects(
      () => withFetch(() => aiRouterHttpError(500), () => runQualityGate(pool, projectId, { text: 'Some real post text.', channels: ['telegram'] })),
      /AI Router|QualityGateError/,
    )
    // runQualityGate never receives a mutable reference to the caller's own state — it only ever
    // returns a review or throws, so there is nothing here it could have mutated.
  })
})

test('requirement: Brand Profile is applied — the prompt sent to the AI Router carries the project\'s own tone/constraints/CTA', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    await saveProjectBrandVoice(pool, projectId, {
      toneStyle: 'Expert and friendly, never pushy',
      constraints: 'Never promise same-day service',
      preferredCta: 'Book via WhatsApp',
    })

    let sentPrompt = ''
    await withFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        sentPrompt = body.messages.map((m: { content: string }) => m.content).join('\n')
        return aiRouterOk(JSON.stringify({ summary: 'ok', findings: [] }))
      },
      () => runQualityGate(pool, projectId, { text: 'Original post text', channels: ['telegram'] }),
    )
    assert.ok(sentPrompt.includes('Expert and friendly, never pushy'))
    assert.ok(sentPrompt.includes('Never promise same-day service'))
    assert.ok(sentPrompt.includes('Book via WhatsApp'))
  })
})

test('requirement: project isolation — checking project A never sends project B\'s Brand Profile', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectA = await makeProject('DriveSet')
    const projectB = await makeProject('CleanTrack')
    await saveProjectBrandVoice(pool, projectA, { toneStyle: 'For DriveSet only' })
    await saveProjectBrandVoice(pool, projectB, { toneStyle: 'For CleanTrack only' })

    let sentPrompt = ''
    await withFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        sentPrompt = body.messages.map((m: { content: string }) => m.content).join('\n')
        return aiRouterOk(JSON.stringify({ summary: 'ok', findings: [] }))
      },
      () => runQualityGate(pool, projectA, { text: 'Original post text', channels: ['telegram'] }),
    )
    assert.ok(sentPrompt.includes('For DriveSet only'))
    assert.ok(!sentPrompt.includes('For CleanTrack only'), "checking project A must never carry project B's Brand Profile")
  })
})

test('requirement: the AI Router call includes the selected platform(s), for the platform-fit criterion', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    let sentPrompt = ''
    await withFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        sentPrompt = body.messages.map((m: { content: string }) => m.content).join('\n')
        return aiRouterOk(JSON.stringify({ summary: 'ok', findings: [] }))
      },
      () => runQualityGate(pool, projectId, { text: 'Some post text', channels: ['vk', 'instagram'] }),
    )
    assert.ok(sentPrompt.includes('vk, instagram'))
  })
})

test('requirement: runQualityGate never issues a write query — it is read-only, never auto-saves or auto-publishes anything', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    const { pool: loggedPool, queries } = withQueryLog(pool)
    await withFetch(() => aiRouterOk(JSON.stringify({ summary: 'ok', findings: [] })), () =>
      runQualityGate(loggedPool, projectId, { text: 'Some post text', channels: ['telegram'] }),
    )
    const writeQueries = queries.filter((q) => /\b(INSERT|UPDATE|DELETE)\b/i.test(q))
    assert.deepEqual(writeQueries, [], 'runQualityGate must only ever read — no INSERT/UPDATE/DELETE')
  })
})

test('requirement: a response that is unparseable JSON is a clear error, never a lost/garbled original text', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    await assert.rejects(
      () => withFetch(() => aiRouterOk('not json at all'), () => runQualityGate(pool, projectId, { text: 'Some post text', channels: ['telegram'] })),
      QualityGateError,
    )
  })
})
