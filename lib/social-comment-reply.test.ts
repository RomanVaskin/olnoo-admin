import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { getCommentForReply, suggestCommentReply, sendCommentReply } from './social-comment-reply.ts'

// DB integration (skipped without a reachable Postgres) — same convention as
// lib/social-comments.test.ts / lib/social-publication-claim.test.ts.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(
  t: TestContext,
  fn: (
    pool: Pool,
    ctx: {
      makeCommentWithThread: (opts?: {
        channelUsername?: string
        discussionChatId?: string
        externalCommentId?: string
        commentBody?: string
        authorUsername?: string
        postBody?: string
        telegramText?: string
      }) => Promise<{ projectId: number; commentId: string; discussionChatId: string; externalCommentId: string }>
      makeCommentWithoutThread: (commentBody?: string) => Promise<{ projectId: number; commentId: string }>
    },
  ) => Promise<void>,
) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT id FROM social_comments LIMIT 1')
    await pool.query('SELECT id FROM social_comment_replies LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the social_comment_replies schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }

  const clientIds: number[] = []

  const makeProject = async () => {
    const clientId = (
      await pool.query(`INSERT INTO clients (name) VALUES ('__test_comment_reply__' || clock_timestamp()::text) RETURNING id`)
    ).rows[0].id as number
    clientIds.push(clientId)
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        'comment reply test',
        `${slug}.example`,
        slug,
      ])
    ).rows[0].id as number
    return projectId
  }

  const makeCommentWithThread = async (opts: {
    channelUsername?: string
    discussionChatId?: string
    externalCommentId?: string
    commentBody?: string
    authorUsername?: string
    postBody?: string
    telegramText?: string
  } = {}) => {
    const projectId = await makeProject()
    const channelUsername = opts.channelUsername ?? `@olnoo_channel_${randomUUID().slice(0, 8)}`
    await pool.query(
      `INSERT INTO social_accounts (id, project_id, platform, name, username, status, active)
       VALUES ($1, $2, 'telegram', 'test channel', $3, 'connected', true)`,
      [randomUUID(), projectId, channelUsername],
    )
    const postId = randomUUID()
    await pool.query(
      `INSERT INTO social_posts (id, project_id, topic, category, body, telegram_text, channels, publish_date, status)
       VALUES ($1, $2, 'test post', '', $3, $4, 'telegram', '', 'ready')`,
      [postId, projectId, opts.postBody ?? 'Our newest feature is live today.', opts.telegramText ?? ''],
    )
    const discussionChatId = opts.discussionChatId ?? `-100${Math.floor(1000000000 + Math.random() * 8999999999)}`
    const publicationId = randomUUID()
    await pool.query(
      `INSERT INTO social_publications
         (id, project_id, social_post_id, platform, status, external_post_id, telegram_discussion_chat_id, telegram_discussion_thread_id)
       VALUES ($1, $2, $3, 'telegram', 'published', '42', $4, '555')`,
      [publicationId, projectId, postId, discussionChatId],
    )
    const commentId = randomUUID()
    const externalCommentId = opts.externalCommentId ?? String(Math.floor(1 + Math.random() * 1_000_000))
    await pool.query(
      `INSERT INTO social_comments
         (id, project_id, social_publication_id, platform, external_comment_id, author_name, author_username, body, external_posted_at)
       VALUES ($1, $2, $3, 'telegram', $4, 'Tester', $5, $6, now())`,
      [commentId, projectId, publicationId, externalCommentId, opts.authorUsername ?? 'tester', opts.commentBody ?? 'How much does this cost?'],
    )
    return { projectId, commentId, discussionChatId, externalCommentId }
  }

  const makeCommentWithoutThread = async (commentBody = 'A comment with nothing to reply into') => {
    const projectId = await makeProject()
    const commentId = randomUUID()
    await pool.query(
      `INSERT INTO social_comments (id, project_id, social_publication_id, platform, external_comment_id, author_name, author_username, body)
       VALUES ($1, $2, NULL, 'telegram', $3, 'Tester', 'tester', $4)`,
      [commentId, projectId, String(Math.floor(1 + Math.random() * 1_000_000)), commentBody],
    )
    return { projectId, commentId }
  }

  try {
    await fn(pool, { makeCommentWithThread, makeCommentWithoutThread })
  } finally {
    for (const clientId of clientIds) {
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]) // cascades to everything
    }
    await pool.end()
  }
}

/** Scripted global fetch (same approach as lib/ai-router.test.ts / lib/social-telegram-verify.test.ts). */
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

function telegramOk(messageId: number): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function telegramError(description: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, description }), { status, headers: { 'Content-Type': 'application/json' } })
}

function aiRouterOk(content: string): Response {
  return new Response(JSON.stringify({ id: 'r1', requestId: 'req1', provider: 'openai', model: 'gpt', content }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// --- Project isolation ---

test('getCommentForReply: a comment id from another project resolves as not found', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    const otherProjectId = projectId + 1_000_000 // guaranteed not to exist / not to be this comment's project
    assert.equal(await getCommentForReply(pool, otherProjectId, commentId), null)
    assert.notEqual(await getCommentForReply(pool, projectId, commentId), null)
  })
})

test('sendCommentReply: a comment id scoped to a different project is refused as not found, never sends', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    let telegramCalled = false
    const result = await withFetch(
      () => {
        telegramCalled = true
        return telegramOk(999)
      },
      () => sendCommentReply(pool, projectId + 1_000_000, commentId, 'Thanks for asking!'),
    )
    assert.equal('error' in result && result.status, 404)
    assert.equal(telegramCalled, false, 'Telegram must never be called for a comment outside the given project')
  })
})

test('two different projects\' comments are fully isolated — a reply sent in one never appears in the other', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const a = await makeCommentWithThread()
    const b = await makeCommentWithThread()

    await withFetch(() => telegramOk(111), () => sendCommentReply(pool, a.projectId, a.commentId, 'Reply for A'))

    const contextA = await getCommentForReply(pool, a.projectId, a.commentId)
    const contextB = await getCommentForReply(pool, b.projectId, b.commentId)
    assert.equal(contextA?.existingReply?.status, 'sent')
    assert.equal(contextB?.existingReply, null, 'project B\'s comment must be unaffected by project A\'s reply')
  })
})

// --- reply_to_message_id correctness ---

test('sendCommentReply sends into the comment\'s own discussion chat, as a reply to the comment\'s own message id', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId, discussionChatId, externalCommentId } = await makeCommentWithThread()

    let capturedBody: Record<string, unknown> | null = null
    const result = await withFetch(
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body))
        return telegramOk(777)
      },
      () => sendCommentReply(pool, projectId, commentId, 'Great question — happy to help!'),
    )

    assert.ok('row' in result)
    if ('row' in result) {
      assert.equal(result.row.status, 'sent')
      assert.equal(result.row.externalReplyMessageId, '777')
    }
    assert.equal(capturedBody!.chat_id, discussionChatId)
    assert.equal(capturedBody!.reply_to_message_id, Number(externalCommentId))
    assert.equal(capturedBody!.text, 'Great question — happy to help!')
  })
})

test('sendCommentReply refuses a comment with no discussion thread to reply into — never calls Telegram', async (t) => {
  await withDb(t, async (pool, { makeCommentWithoutThread }) => {
    const { projectId, commentId } = await makeCommentWithoutThread()
    let telegramCalled = false
    const result = await withFetch(
      () => {
        telegramCalled = true
        return telegramOk(1)
      },
      () => sendCommentReply(pool, projectId, commentId, 'Reply text'),
    )
    assert.equal('error' in result && result.status, 400)
    assert.equal(telegramCalled, false)
  })
})

// --- No double send: double-click (sequential) and concurrent requests ---

test('double-click: a second send-reply call after a successful send is refused, Telegram is called exactly once', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    let telegramCalls = 0
    await withFetch(
      () => {
        telegramCalls++
        return telegramOk(42)
      },
      async () => {
        const first = await sendCommentReply(pool, projectId, commentId, 'First attempt')
        assert.ok('row' in first && first.row.status === 'sent')
        const second = await sendCommentReply(pool, projectId, commentId, 'Second attempt — must be refused')
        assert.equal('error' in second && second.status, 409)
      },
    )
    assert.equal(telegramCalls, 1, 'Telegram must only ever be called once for this comment')
  })
})

test('concurrent requests: two simultaneous send-reply calls for the SAME comment — exactly one reaches Telegram, exactly one row is ever created', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    let telegramCalls = 0
    const [first, second] = await withFetch(
      () => {
        telegramCalls++
        return telegramOk(99)
      },
      () =>
        Promise.all([
          sendCommentReply(pool, projectId, commentId, 'Concurrent attempt 1'),
          sendCommentReply(pool, projectId, commentId, 'Concurrent attempt 2'),
        ]),
    )
    const results = [first, second]
    const winners = results.filter((r) => 'row' in r && r.row.status === 'sent')
    const losers = results.filter((r) => 'error' in r)
    assert.equal(winners.length, 1, 'exactly one concurrent send must win')
    assert.equal(losers.length, 1, 'exactly one concurrent send must be refused')
    assert.equal(telegramCalls, 1, 'Telegram must only ever be called once, regardless of the race')

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM social_comment_replies WHERE social_comment_id = $1', [commentId])
    assert.equal(rows[0].n, 1, 'exactly one reply row must ever exist for this comment')
  })
})

// --- Unknown Telegram outcome: never auto-retried ---

test('an unknown Telegram outcome (network failure) leaves the row at "sending", returns 503, and is never auto-retried on a later call', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    let telegramCalls = 0

    const first = await withFetch(
      () => {
        telegramCalls++
        return new Error('socket hang up')
      },
      () => sendCommentReply(pool, projectId, commentId, 'Will this actually send?'),
    )
    assert.equal('error' in first && first.status, 503)

    const context = await getCommentForReply(pool, projectId, commentId)
    assert.equal(context?.existingReply?.status, 'sending', 'an unknown outcome must leave the row as "sending", never "failed"')

    // A later call (automatic or manual) must be refused, not silently retried — this is the
    // no-auto-retry requirement, enforced by the SAME unique-row mechanism that prevents
    // double-sends, not a separate check.
    const second = await withFetch(
      () => {
        telegramCalls++
        return telegramOk(555)
      },
      () => sendCommentReply(pool, projectId, commentId, 'Retry attempt'),
    )
    assert.equal('error' in second && second.status, 409)
    assert.equal(telegramCalls, 1, 'the second call must never reach Telegram at all')
  })
})

test('a definitive Telegram rejection is recorded as "failed", with the error', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    const result = await withFetch(
      () => telegramError('Bad Request: message to be replied not found', 400),
      () => sendCommentReply(pool, projectId, commentId, 'Reply text'),
    )
    assert.ok('row' in result)
    if ('row' in result) {
      assert.equal(result.row.status, 'failed')
      assert.ok(result.row.error.includes('message to be replied not found'))
    }
  })
})

// --- Manual retry after a CONFIRMED failure (requirement 1): atomic failed -> sending, same row,
// no second reply, no parallel-retry double send. ---

test('requirement 1: a manual retry after a CONFIRMED failure is allowed, reuses the SAME row, and succeeds', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()

    const first = await withFetch(
      () => telegramError('Bad Request: message to be replied not found', 400),
      () => sendCommentReply(pool, projectId, commentId, 'First attempt — will fail'),
    )
    assert.ok('row' in first && first.row.status === 'failed')
    const firstRowId = 'row' in first ? first.row.id : ''

    const retried = await withFetch(() => telegramOk(888), () => sendCommentReply(pool, projectId, commentId, 'Retried attempt — will succeed'))
    assert.ok('row' in retried)
    if ('row' in retried) {
      assert.equal(retried.row.status, 'sent')
      assert.equal(retried.row.externalReplyMessageId, '888')
      assert.equal(retried.row.id, firstRowId, 'the retry must reuse the SAME row — never create a second reply')
    }

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM social_comment_replies WHERE social_comment_id = $1', [commentId])
    assert.equal(rows[0].n, 1, 'exactly one reply row must ever exist, even after a retry')
  })
})

test('requirement 1: a retry can itself fail again and be retried again — repeated confirmed failures never create extra rows', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()

    await withFetch(() => telegramError('First rejection', 400), () => sendCommentReply(pool, projectId, commentId, 'Attempt 1'))
    await withFetch(() => telegramError('Second rejection', 400), () => sendCommentReply(pool, projectId, commentId, 'Attempt 2'))
    const third = await withFetch(() => telegramOk(42), () => sendCommentReply(pool, projectId, commentId, 'Attempt 3 — succeeds'))

    assert.ok('row' in third && third.row.status === 'sent')
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM social_comment_replies WHERE social_comment_id = $1', [commentId])
    assert.equal(rows[0].n, 1, 'repeated confirmed failures and retries must never create a second row')
  })
})

test('parallel retries after a confirmed failure: two simultaneous retry attempts — exactly one reaches Telegram, exactly one row ever exists', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    await withFetch(() => telegramError('Initial rejection', 400), () => sendCommentReply(pool, projectId, commentId, 'Initial attempt'))

    let telegramCalls = 0
    const [first, second] = await withFetch(
      () => {
        telegramCalls++
        return telegramOk(123)
      },
      () =>
        Promise.all([
          sendCommentReply(pool, projectId, commentId, 'Concurrent retry 1'),
          sendCommentReply(pool, projectId, commentId, 'Concurrent retry 2'),
        ]),
    )
    const results = [first, second]
    const winners = results.filter((r) => 'row' in r && r.row.status === 'sent')
    const losers = results.filter((r) => 'error' in r && r.status === 409)
    assert.equal(winners.length, 1, 'exactly one concurrent retry must win')
    assert.equal(losers.length, 1, 'exactly one concurrent retry must be refused with 409')
    assert.equal(telegramCalls, 1, 'Telegram must only ever be called once, regardless of the race')

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM social_comment_replies WHERE social_comment_id = $1', [commentId])
    assert.equal(rows[0].n, 1, 'exactly one reply row must ever exist, even after a concurrent retry race')
  })
})

// --- Requirement 2: retry is strictly forbidden for "sending" (unknown) and "sent" — never, under
// any circumstance, reclaimable through this function. ---

test('requirement 2: retry is strictly forbidden while a prior outcome is unresolved ("sending") — the retry attempt never reaches Telegram, and status is left untouched', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    const unresolved = await withFetch(() => new Error('socket hang up'), () => sendCommentReply(pool, projectId, commentId, 'Will this send?'))
    assert.equal('error' in unresolved && unresolved.status, 503)

    let telegramCalls = 0
    const retry = await withFetch(
      () => {
        telegramCalls++
        return telegramOk(1)
      },
      () => sendCommentReply(pool, projectId, commentId, 'Attempted retry while unresolved'),
    )
    assert.equal('error' in retry && retry.status, 409, 'a retry while unresolved must be refused, never silently accepted')
    assert.equal(telegramCalls, 0, 'a retry while the outcome is unknown must never reach Telegram')

    const context = await getCommentForReply(pool, projectId, commentId)
    assert.equal(context?.existingReply?.status, 'sending', 'the row must stay exactly as it was — a refused retry must never move it')
  })
})

test('requirement 2: retry is strictly forbidden once a reply has already been sent', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()
    await withFetch(() => telegramOk(1), () => sendCommentReply(pool, projectId, commentId, 'First, successful attempt'))

    let telegramCalls = 0
    const retry = await withFetch(
      () => {
        telegramCalls++
        return telegramOk(2)
      },
      () => sendCommentReply(pool, projectId, commentId, 'An attempted retry after success'),
    )
    assert.equal('error' in retry && retry.status, 409)
    assert.equal(telegramCalls, 0, 'a retry after a successful send must never reach Telegram')
  })
})

// --- AI suggestion ---

test('suggestCommentReply asks the AI Router with the comment and its original post as context, and returns its answer', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread({
      commentBody: 'Сколько это стоит?',
      telegramText: 'Мы запустили новую функцию сегодня.',
    })

    let capturedBody: Record<string, unknown> | null = null
    const result = await withFetch(
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body))
        return aiRouterOk('Спасибо за вопрос! Напишите нам в личные сообщения, и мы подскажем точную стоимость.')
      },
      () => suggestCommentReply(pool, projectId, commentId),
    )

    assert.ok('reply' in result)
    if ('reply' in result) {
      assert.equal(result.reply, 'Спасибо за вопрос! Напишите нам в личные сообщения, и мы подскажем точную стоимость.')
    }
    const messages = capturedBody!.messages as Array<{ role: string; content: string }>
    const userMessage = messages.find((m) => m.role === 'user')!.content
    assert.ok(userMessage.includes('Мы запустили новую функцию сегодня.'), 'the original post must be part of the prompt')
    assert.ok(userMessage.includes('Сколько это стоит?'), 'the comment itself must be part of the prompt')
  })
})

test('suggestCommentReply never writes anything and can be called again ("Сгенерировать заново") with a different result', async (t) => {
  await withDb(t, async (pool, { makeCommentWithThread }) => {
    const { projectId, commentId } = await makeCommentWithThread()

    const first = await withFetch(() => aiRouterOk('First suggestion'), () => suggestCommentReply(pool, projectId, commentId))
    const second = await withFetch(() => aiRouterOk('Second, regenerated suggestion'), () => suggestCommentReply(pool, projectId, commentId))

    assert.ok('reply' in first && first.reply === 'First suggestion')
    assert.ok('reply' in second && second.reply === 'Second, regenerated suggestion')

    // Neither call ever persisted anything — no reply row exists until sendCommentReply is called.
    const context = await getCommentForReply(pool, projectId, commentId)
    assert.equal(context?.existingReply, null)
  })
})

test('suggestCommentReply for an unknown comment returns a 404-style result, never throws', async (t) => {
  await withDb(t, async (pool) => {
    const result = await suggestCommentReply(pool, 1, randomUUID())
    assert.equal('error' in result && result.status, 404)
  })
})
