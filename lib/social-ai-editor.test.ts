import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  EDITOR_ACTIONS,
  EDITOR_SYSTEM_PROMPT,
  isEditorAction,
  buildEditorUserPrompt,
  cleanEditorOutput,
  editSocialPostText,
  SocialAiEditorError,
} from './social-ai-editor.ts'
import { saveProjectBrandVoice } from './project-brand-voice.ts'

// --- Pure: isEditorAction / buildEditorUserPrompt / cleanEditorOutput ---

test('isEditorAction: accepts exactly the known actions, rejects anything else', () => {
  for (const action of EDITOR_ACTIONS) assert.equal(isEditorAction(action), true)
  assert.equal(isEditorAction('delete_everything'), false)
  assert.equal(isEditorAction(42), false)
  assert.equal(isEditorAction(undefined), false)
})

test('buildEditorUserPrompt: a preset action uses its own instruction, ignoring customInstruction', () => {
  const prompt = buildEditorUserPrompt({ text: 'Hello world', action: 'shorten', customInstruction: 'ignored for presets', contextBlock: 'CTX' })
  assert.ok(prompt.includes('Hello world'))
  assert.ok(prompt.includes('Shorten TEXT'))
  assert.ok(!prompt.includes('ignored for presets'))
  assert.ok(prompt.includes('CTX'))
})

test('buildEditorUserPrompt: the custom action uses customInstruction verbatim', () => {
  const prompt = buildEditorUserPrompt({ text: 'Hello world', action: 'custom', customInstruction: 'Make it rhyme', contextBlock: 'CTX' })
  assert.ok(prompt.includes('INSTRUCTION: Make it rhyme'))
})

test('cleanEditorOutput: strips a markdown code fence', () => {
  assert.equal(cleanEditorOutput('```\nEdited text\n```'), 'Edited text')
  assert.equal(cleanEditorOutput('```text\nEdited text\n```'), 'Edited text')
})

test('cleanEditorOutput: strips one layer of surrounding quotes', () => {
  assert.equal(cleanEditorOutput('"Edited text"'), 'Edited text')
  assert.equal(cleanEditorOutput('«Edited text»'), 'Edited text')
})

test('cleanEditorOutput: plain text is returned trimmed, unchanged otherwise', () => {
  assert.equal(cleanEditorOutput('  Edited text  '), 'Edited text')
})

test('requirement: the system prompt never hardcodes OLNOO (or any other fixed brand) as the subject', () => {
  assert.ok(!EDITOR_SYSTEM_PROMPT.includes('OLNOO'))
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
      await pool.query(`INSERT INTO clients (name) VALUES ('__test_ai_editor__' || clock_timestamp()::text) RETURNING id`)
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

/** Scripted global fetch for the AI Router call (same approach as lib/social-agent.test.ts). */
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

test('editSocialPostText: a preset action returns the AI Router\'s (cleaned) proposal', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    const result = await withFetch(() => aiRouterOk('```\nA shorter version.\n```'), () =>
      editSocialPostText(pool, projectId, { text: 'A much longer original version of the post.', action: 'shorten' }),
    )
    assert.equal(result, 'A shorter version.')
  })
})

test('editSocialPostText: empty text is refused before any AI Router call', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    let fetchCalled = false
    await assert.rejects(
      () =>
        withFetch(
          () => {
            fetchCalled = true
            return aiRouterOk('x')
          },
          () => editSocialPostText(pool, projectId, { text: '   ', action: 'improve' }),
        ),
      SocialAiEditorError,
    )
    assert.equal(fetchCalled, false)
  })
})

test('editSocialPostText: the custom action without an instruction is refused before any AI Router call', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    let fetchCalled = false
    await assert.rejects(
      () =>
        withFetch(
          () => {
            fetchCalled = true
            return aiRouterOk('x')
          },
          () => editSocialPostText(pool, projectId, { text: 'Some text', action: 'custom', customInstruction: '  ' }),
        ),
      SocialAiEditorError,
    )
    assert.equal(fetchCalled, false)
  })
})

test('requirement: an AI Router failure never loses or mutates the original text — the caller receives a thrown error', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    const originalText = 'The exact original text, untouched.'
    await assert.rejects(
      () => withFetch(() => aiRouterHttpError(500), () => editSocialPostText(pool, projectId, { text: originalText, action: 'improve' })),
      /AI Router|SocialAiEditorError/,
    )
    // editSocialPostText never receives a mutable reference to the caller's own state — it only
    // ever returns a new proposal or throws, so there is nothing here it could have mutated.
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
        return aiRouterOk('Edited text')
      },
      () => editSocialPostText(pool, projectId, { text: 'Original post text', action: 'improve' }),
    )
    assert.ok(sentPrompt.includes('Expert and friendly, never pushy'))
    assert.ok(sentPrompt.includes('Never promise same-day service'))
    assert.ok(sentPrompt.includes('Book via WhatsApp'))
  })
})

test('requirement: project isolation — editing for project A never sends project B\'s Brand Profile', async (t) => {
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
        return aiRouterOk('Edited text')
      },
      () => editSocialPostText(pool, projectA, { text: 'Original post text', action: 'improve' }),
    )
    assert.ok(sentPrompt.includes('For DriveSet only'))
    assert.ok(!sentPrompt.includes('For CleanTrack only'), "editing for project A must never carry project B's Brand Profile")
  })
})

test('requirement: for a non-OLNOO project (DriveSet), the prompt sent contains no hardcoded instruction to write as/for OLNOO', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    let sentSystemPrompt = ''
    let sentUserPrompt = ''
    await withFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        sentSystemPrompt = body.messages.find((m: { role: string }) => m.role === 'system')?.content ?? ''
        sentUserPrompt = body.messages.find((m: { role: string }) => m.role === 'user')?.content ?? ''
        return aiRouterOk('Edited text')
      },
      () => editSocialPostText(pool, projectId, { text: 'Original post text', action: 'improve' }),
    )
    assert.ok(!sentSystemPrompt.includes('OLNOO'))
    assert.ok(!sentUserPrompt.includes('OLNOO'))
    assert.ok(sentUserPrompt.includes('DriveSet'))
  })
})
