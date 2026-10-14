import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { handleTelegramCommentsUpdate, type TelegramCommentsDeps } from './telegram-comments-handler.ts'
import {
  linkAutoForward,
  resolveThread,
  insertCommentIfNew,
  listCommentsForProject,
  resolvePendingAutoForwardForPublication,
} from './social-comments.ts'

// End-to-end regression: REAL raw Telegram Update JSON (the full envelope a webhook actually
// receives, not just the inner `message`), through the REAL classifier
// (lib/social-telegram-comments.ts, via handleTelegramCommentsUpdate) and the REAL DB-backed
// social-comments.ts functions — no fakes anywhere in this file. DB integration (skipped without
// a reachable Postgres), same convention as lib/social-comments.test.ts.
//
// Every fixture below is generated with a unique channel username / chat id / external post id
// PER TEST (never a shared module-level constant) — node:test runs sibling top-level tests
// concurrently by default, and social_publications has a real unique index on
// (telegram_discussion_chat_id, telegram_discussion_thread_id); two concurrently-running tests
// that happened to share the same channel username and post id could otherwise cross-match each
// other's project, exactly the kind of isolation bug this file exists to catch — so the fixtures
// themselves must not create one.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(
  t: TestContext,
  fn: (
    pool: Pool,
    deps: TelegramCommentsDeps & { notified: unknown[] },
    ctx: { projectId: number; publicationId: string; channelUsername: string; discussionChatId: string; postMessageId: string },
  ) => Promise<void>,
) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT telegram_discussion_chat_id FROM social_publications LIMIT 1')
    await pool.query('SELECT id FROM social_comments LIMIT 1')
    await pool.query('SELECT id FROM social_telegram_pending_auto_forwards LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the social_comments schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }

  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const channelUsername = `olnoo_channel_${unique}`
  const discussionChatId = `-100${Math.floor(1000000000 + Math.random() * 8999999999)}`
  const postMessageId = String(Math.floor(1 + Math.random() * 1_000_000))

  const clientId = (
    await pool.query(`INSERT INTO clients (name) VALUES ('__test_tg_comments_flow__' || clock_timestamp()::text) RETURNING id`)
  ).rows[0].id as number
  const slug = `t${unique}`
  const projectId = (
    await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
      clientId,
      'webhook flow test',
      `${slug}.example`,
      slug,
    ])
  ).rows[0].id as number
  await pool.query(
    `INSERT INTO social_accounts (id, project_id, platform, name, username, status, active)
     VALUES ($1, $2, 'telegram', 'test channel', $3, 'connected', true)`,
    [randomUUID(), projectId, `@${channelUsername}`],
  )
  const postId = randomUUID()
  await pool.query(
    `INSERT INTO social_posts (id, project_id, topic, category, body, channels, publish_date, status)
     VALUES ($1, $2, 'test post', '', '', 'telegram', '', 'ready')`,
    [postId, projectId],
  )
  const publicationId = randomUUID()
  await pool.query(
    `INSERT INTO social_publications (id, project_id, social_post_id, platform, status, external_post_id)
     VALUES ($1, $2, $3, 'telegram', 'published', $4)`,
    [publicationId, projectId, postId, postMessageId],
  )

  const notified: unknown[] = []
  const deps: TelegramCommentsDeps & { notified: unknown[] } = {
    linkAutoForward: (event) => linkAutoForward(pool, event),
    resolveThread: (chatId, threadId) => resolveThread(pool, chatId, threadId),
    insertCommentIfNew: (pid, pubId, event) => insertCommentIfNew(pool, pid, pubId, event),
    notifyNewComment: async (pid, commentId, event) => {
      notified.push({ pid, commentId, event })
    },
    notified,
  }

  try {
    await fn(pool, deps, { projectId, publicationId, channelUsername, discussionChatId, postMessageId })
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
}

/** A realistic full Update envelope for the channel post's automatic forward into the discussion
 * group, using the CURRENT forward_origin shape (Bot API >= 7.0). The group's own message id for
 * this forwarded copy (`threadMessageId`) is distinct from the channel's own `postMessageId`
 * (real Telegram behavior — different chats, different id spaces). */
function autoForwardUpdate(updateId: number, discussionChatId: string, threadMessageId: number, channelUsername: string, postMessageId: string) {
  return {
    update_id: updateId,
    message: {
      message_id: threadMessageId,
      date: 1700000000,
      chat: { id: Number(discussionChatId), type: 'supergroup', title: 'OLNOO Discussion' },
      is_automatic_forward: true,
      forward_origin: {
        type: 'channel',
        date: 1699999000,
        chat: { id: -1009876543210, type: 'channel', title: 'OLNOO', username: channelUsername },
        message_id: Number(postMessageId),
      },
      text: 'Our newest update is live!',
    },
  }
}

/** A realistic top-level comment reply, in the SAME discussion group, threaded to the post above. */
function commentUpdate(updateId: number, discussionChatId: string, threadMessageId: number, messageId: number, text: string, userId = 999) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1700000100,
      chat: { id: Number(discussionChatId), type: 'supergroup', title: 'OLNOO Discussion' },
      message_thread_id: threadMessageId,
      from: { id: userId, is_bot: false, first_name: 'Anna', last_name: 'K', username: 'anna_k' },
      reply_to_message: { message_id: threadMessageId, is_automatic_forward: true },
      text,
    },
  }
}

test('end-to-end: a real auto-forward Update links the thread, then a real comment Update is recorded', async (t) => {
  await withDb(t, async (pool, deps, { projectId, publicationId, channelUsername, discussionChatId, postMessageId }) => {
    const forward = autoForwardUpdate(100001, discussionChatId, 555, channelUsername, postMessageId)
    const forwardOutcome = await handleTelegramCommentsUpdate(forward, deps)
    assert.deepEqual(forwardOutcome, { action: 'thread_linked', projectId, publicationId })

    const comment = commentUpdate(100002, discussionChatId, 555, 556, 'Congrats on the launch!')
    const commentOutcome = await handleTelegramCommentsUpdate(comment, deps)
    assert.equal(commentOutcome.action, 'comment_recorded')

    const rows = await listCommentsForProject(pool, projectId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].body, 'Congrats on the launch!')
    assert.equal(rows[0].author_username, 'anna_k')
  })
})

test('end-to-end: Telegram redelivering the EXACT SAME raw Update JSON (webhook retry) never creates a duplicate comment or a second notification', async (t) => {
  await withDb(t, async (pool, deps, { projectId, discussionChatId, channelUsername, postMessageId }) => {
    await handleTelegramCommentsUpdate(autoForwardUpdate(100001, discussionChatId, 555, channelUsername, postMessageId), deps)
    const update = commentUpdate(100003, discussionChatId, 555, 557, 'nice work team')

    const first = await handleTelegramCommentsUpdate(update, deps)
    // Telegram got no 200 in time, or this app retried after a transient failure — redeliver the
    // identical update object.
    const second = await handleTelegramCommentsUpdate(JSON.parse(JSON.stringify(update)), deps)

    assert.equal(first.action, 'comment_recorded')
    assert.deepEqual(second, { action: 'comment_duplicate' })

    const rows = await listCommentsForProject(pool, projectId)
    assert.equal(rows.length, 1, 'redelivery must never create a second row')
    assert.equal(deps.notified.length, 1, 'redelivery must never trigger a second notification')
  })
})

test('end-to-end: redelivering the auto-forward Update itself is also a safe no-op (idempotent thread link)', async (t) => {
  await withDb(t, async (pool, deps, { projectId, publicationId, discussionChatId, channelUsername, postMessageId }) => {
    const forward = autoForwardUpdate(100001, discussionChatId, 555, channelUsername, postMessageId)
    const first = await handleTelegramCommentsUpdate(forward, deps)
    const second = await handleTelegramCommentsUpdate(JSON.parse(JSON.stringify(forward)), deps)
    assert.deepEqual(first, second)
    assert.deepEqual(first, { action: 'thread_linked', projectId, publicationId })
  })
})

test('end-to-end: the auto-forward webhook Update arrives BEFORE the publish call commits external_post_id — the thread still links once the publish lands, and comments then resolve', async (t) => {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT telegram_discussion_chat_id FROM social_publications LIMIT 1')
    await pool.query('SELECT id FROM social_telegram_pending_auto_forwards LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the social_comments schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }

  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const channelUsername = `olnoo_channel_${unique}`
  const discussionChatId = `-100${Math.floor(1000000000 + Math.random() * 8999999999)}`
  const postMessageId = String(Math.floor(1 + Math.random() * 1_000_000))

  const clientId = (
    await pool.query(`INSERT INTO clients (name) VALUES ('__test_tg_comments_race__' || clock_timestamp()::text) RETURNING id`)
  ).rows[0].id as number
  try {
    const slug = `t${unique}`
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        'webhook race test',
        `${slug}.example`,
        slug,
      ])
    ).rows[0].id as number
    await pool.query(
      `INSERT INTO social_accounts (id, project_id, platform, name, username, status, active)
       VALUES ($1, $2, 'telegram', 'test channel', $3, 'connected', true)`,
      [randomUUID(), projectId, `@${channelUsername}`],
    )
    const postId = randomUUID()
    await pool.query(
      `INSERT INTO social_posts (id, project_id, topic, category, body, channels, publish_date, status)
       VALUES ($1, $2, 'test post', '', '', 'telegram', '', 'ready')`,
      [postId, projectId],
    )
    // Mid-publish — exactly the moment BEFORE lib/social-telegram.ts's own success UPDATE commits
    // external_post_id. This is the state a real publication is in for however long sendMessage's
    // HTTP round trip takes, and Telegram's own auto-forward + webhook delivery can easily beat it.
    const publicationId = randomUUID()
    await pool.query(
      `INSERT INTO social_publications (id, project_id, social_post_id, platform, status)
       VALUES ($1, $2, $3, 'telegram', 'publishing')`,
      [publicationId, projectId, postId],
    )

    const notified: unknown[] = []
    const deps: TelegramCommentsDeps & { notified: unknown[] } = {
      linkAutoForward: (event) => linkAutoForward(pool, event),
      resolveThread: (chatId, threadId) => resolveThread(pool, chatId, threadId),
      insertCommentIfNew: (pid, pubId, event) => insertCommentIfNew(pool, pid, pubId, event),
      notifyNewComment: async (pid, commentId, event) => {
        notified.push({ pid, commentId, event })
      },
      notified,
    }

    // 1. Telegram's webhook for the auto-forward arrives first.
    const forward = autoForwardUpdate(200001, discussionChatId, 555, channelUsername, postMessageId)
    const forwardOutcome = await handleTelegramCommentsUpdate(forward, deps)
    assert.deepEqual(forwardOutcome, { action: 'thread_unknown' }, 'nothing to match yet, but this must not be an error outcome')

    // 2. A viewer comments before the publish side has caught up — correctly unattributed, not
    // silently misattributed to the wrong project or crashed on.
    const earlyComment = commentUpdate(200002, discussionChatId, 555, 556, 'too early')
    assert.deepEqual(await handleTelegramCommentsUpdate(earlyComment, deps), { action: 'comment_unattributed' })

    // 3. The publish call's own sendMessage response now arrives and commits external_post_id —
    // this is exactly where lib/social-telegram.ts calls resolvePendingAutoForwardForPublication.
    await pool.query(
      `UPDATE social_publications SET status = 'published', external_post_id = $1, updated_at = now() WHERE id = $2`,
      [postMessageId, publicationId],
    )
    const resolved = await resolvePendingAutoForwardForPublication(pool, projectId, publicationId, `@${channelUsername}`, postMessageId)
    assert.deepEqual(resolved, { projectId, publicationId })

    // 4. A comment arriving AFTER the thread is finally linked resolves and is recorded — the
    // definition of done this fix exists for.
    const lateComment = commentUpdate(200003, discussionChatId, 555, 557, 'now it works')
    const lateOutcome = await handleTelegramCommentsUpdate(lateComment, deps)
    assert.equal(lateOutcome.action, 'comment_recorded')

    const rows = await listCommentsForProject(pool, projectId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].body, 'now it works')
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
})

test('end-to-end: a reply-to-a-reply (nested comment) in a realistic update is still attributed to the same post', async (t) => {
  await withDb(t, async (pool, deps, { projectId, discussionChatId, channelUsername, postMessageId }) => {
    await handleTelegramCommentsUpdate(autoForwardUpdate(100001, discussionChatId, 555, channelUsername, postMessageId), deps)
    await handleTelegramCommentsUpdate(commentUpdate(100004, discussionChatId, 555, 556, 'first comment'), deps)

    // A nested reply: replies to Anna's comment (556), not to the post (555) — but per Telegram's
    // own behavior, still carries message_thread_id === 555 (the thread root).
    const nestedReply = {
      update_id: 100005,
      message: {
        message_id: 558,
        date: 1700000200,
        chat: { id: Number(discussionChatId), type: 'supergroup' },
        from: { id: 1000, is_bot: false, first_name: 'Boris' },
        reply_to_message: { message_id: 556, message_thread_id: 555 },
        text: 'replying to Anna specifically',
      },
    }
    const outcome = await handleTelegramCommentsUpdate(nestedReply, deps)
    assert.equal(outcome.action, 'comment_recorded')

    const rows = await listCommentsForProject(pool, projectId)
    assert.equal(rows.length, 2)
    assert.ok(rows.some((r) => r.body === 'replying to Anna specifically'))
  })
})
