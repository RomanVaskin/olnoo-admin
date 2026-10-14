import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import {
  linkAutoForward,
  resolveThread,
  insertCommentIfNew,
  listCommentsForProject,
  markCommentNotified,
  listUnnotifiedComments,
  resolvePendingAutoForwardForPublication,
} from './social-comments.ts'
import type { TelegramAutoForwardEvent, TelegramCommentEvent } from './social-telegram-comments.ts'

// DB integration (skipped without a reachable Postgres) — same convention as
// lib/social-publication-claim.test.ts / lib/social-meta-token-refresh-sweep.test.ts.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(
  t: TestContext,
  fn: (
    pool: Pool,
    ctx: {
      makeProject: (channelUsername: string) => Promise<number>
      makePublication: (projectId: number, externalPostId: string) => Promise<string>
      makeDraftPublication: (projectId: number) => Promise<string>
      setExternalPostId: (publicationId: string, externalPostId: string) => Promise<void>
    },
  ) => Promise<void>,
) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT telegram_discussion_chat_id FROM social_publications LIMIT 1')
    await pool.query('SELECT id FROM social_comments LIMIT 1')
    await pool.query('SELECT id FROM social_telegram_pending_auto_forwards LIMIT 1')
    await pool.query('SELECT id FROM social_telegram_pending_comments LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the social_comments schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }

  const clientIds: number[] = []
  const makeProject = async (channelUsername: string) => {
    const clientId = (
      await pool.query(`INSERT INTO clients (name) VALUES ('__test_social_comments__' || clock_timestamp()::text) RETURNING id`)
    ).rows[0].id as number
    clientIds.push(clientId)
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        'comments test',
        `${slug}.example`,
        slug,
      ])
    ).rows[0].id as number
    await pool.query(
      `INSERT INTO social_accounts (id, project_id, platform, name, username, status, active)
       VALUES ($1, $2, 'telegram', 'test channel', $3, 'connected', true)`,
      [randomUUID(), projectId, channelUsername],
    )
    return projectId
  }

  const makePublication = async (projectId: number, externalPostId: string) => {
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
      [publicationId, projectId, postId, externalPostId],
    )
    return publicationId
  }

  /** A publication row still mid-publish — same shape as the moment right before
   * lib/social-telegram.ts's own success UPDATE commits external_post_id, used to reproduce the
   * webhook-before-commit race. */
  const makeDraftPublication = async (projectId: number) => {
    const postId = randomUUID()
    await pool.query(
      `INSERT INTO social_posts (id, project_id, topic, category, body, channels, publish_date, status)
       VALUES ($1, $2, 'test post', '', '', 'telegram', '', 'ready')`,
      [postId, projectId],
    )
    const publicationId = randomUUID()
    await pool.query(
      `INSERT INTO social_publications (id, project_id, social_post_id, platform, status)
       VALUES ($1, $2, $3, 'telegram', 'publishing')`,
      [publicationId, projectId, postId],
    )
    return publicationId
  }

  const setExternalPostId = async (publicationId: string, externalPostId: string) => {
    await pool.query(
      `UPDATE social_publications SET status = 'published', external_post_id = $1, updated_at = now() WHERE id = $2`,
      [externalPostId, publicationId],
    )
  }

  try {
    await fn(pool, { makeProject, makePublication, makeDraftPublication, setExternalPostId })
  } finally {
    for (const clientId of clientIds) {
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]) // cascades to projects -> everything
    }
    await pool.end()
  }
}

function autoForward(forwardFromChatUsername: string, forwardFromMessageId: string, discussionChatId = '-100111', threadId = '555'): TelegramAutoForwardEvent {
  return { kind: 'auto_forward', discussionChatId, threadId, forwardFromChatId: '-100999', forwardFromChatUsername, forwardFromMessageId }
}

function comment(externalCommentId: string, discussionChatId = '-100111', threadId = '555'): TelegramCommentEvent {
  return {
    kind: 'comment',
    discussionChatId,
    threadId,
    externalCommentId,
    authorName: 'Tester',
    authorUsername: 'tester',
    body: 'hello',
    postedAt: new Date('2026-01-01T00:00:00Z'),
  }
}

// --- linkAutoForward / resolveThread ---

test('linkAutoForward matches the channel by username and the post by external_post_id, scoped to that project', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '42')

    const match = await linkAutoForward(pool, autoForward('olnoo_channel', '42'))
    assert.deepEqual(match, { projectId, publicationId })

    const resolved = await resolveThread(pool, '-100111', '555')
    assert.deepEqual(resolved, { projectId, publicationId })
  })
})

test('linkAutoForward returns null for a channel/post it does not know — never guessed', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    await makePublication(projectId, '42')

    assert.equal(await linkAutoForward(pool, autoForward('some_other_channel', '42')), null)
    assert.equal(await linkAutoForward(pool, autoForward('olnoo_channel', '999')), null)
  })
})

test('linkAutoForward is idempotent — redelivering the same auto-forward event does not error or change the mapping', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '42')

    const first = await linkAutoForward(pool, autoForward('olnoo_channel', '42'))
    const second = await linkAutoForward(pool, autoForward('olnoo_channel', '42'))
    assert.deepEqual(first, second)
    assert.deepEqual(first, { projectId, publicationId })
  })
})

test('resolveThread returns null for a thread nothing has ever linked', async (t) => {
  await withDb(t, async (pool) => {
    assert.equal(await resolveThread(pool, '-100111', '999'), null)
  })
})

// --- Race fix: the auto-forward webhook arriving BEFORE the publish call commits external_post_id ---
// (requirement 6 / the real production bug — external_post_id stayed committed-but-unlinked for a
// real publication because this exact order was never handled before.)

test('webhook arrives before external_post_id is committed: linkAutoForward does not lose the event, resolvePendingAutoForwardForPublication completes it once the publish lands', async (t) => {
  await withDb(t, async (pool, { makeProject, makeDraftPublication, setExternalPostId }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makeDraftPublication(projectId)

    // Telegram's auto-forward webhook arrives first — the channel is connected and known, but no
    // publication has external_post_id = '8' yet (the sendMessage response hasn't come back).
    const firstAttempt = await linkAutoForward(pool, autoForward('olnoo_channel', '8'))
    assert.equal(firstAttempt, null, 'nothing to match yet — must not be treated as an error')

    // A comment posted in the window before the thread is ever linked is correctly unattributed,
    // not silently dropped as something else.
    assert.equal(await resolveThread(pool, '-100111', '555'), null)

    // The publish call's own response now arrives and commits external_post_id — this is exactly
    // where lib/social-telegram.ts calls resolvePendingAutoForwardForPublication.
    await setExternalPostId(publicationId, '8')
    const resolved = await resolvePendingAutoForwardForPublication(pool, projectId, publicationId, '@olnoo_channel', '8')
    assert.deepEqual(resolved, { projectId, publicationId })

    // The thread is now linked exactly as if the webhook had arrived second.
    assert.deepEqual(await resolveThread(pool, '-100111', '555'), { projectId, publicationId })
  })
})

test('resolvePendingAutoForwardForPublication: nothing pending resolves to null, never throws', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '8')
    assert.equal(await resolvePendingAutoForwardForPublication(pool, projectId, publicationId, '@olnoo_channel', '8'), null)
  })
})

test('a pending event is consumed once resolved — it cannot be matched again by a second, unrelated publication', async (t) => {
  await withDb(t, async (pool, { makeProject, makeDraftPublication, setExternalPostId }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makeDraftPublication(projectId)

    await linkAutoForward(pool, autoForward('olnoo_channel', '8'))
    await setExternalPostId(publicationId, '8')
    const first = await resolvePendingAutoForwardForPublication(pool, projectId, publicationId, '@olnoo_channel', '8')
    assert.deepEqual(first, { projectId, publicationId })

    // A second, different publication that happens to reuse external_post_id '8' (shouldn't
    // happen in practice — Telegram message ids are not reused — but the pending row must not be
    // reusable regardless) finds nothing left to resolve.
    const secondPublicationId = await makeDraftPublication(projectId)
    await setExternalPostId(secondPublicationId, '8')
    const second = await resolvePendingAutoForwardForPublication(pool, projectId, secondPublicationId, '@olnoo_channel', '8')
    assert.equal(second, null)
  })
})

// --- Residual race (review finding on PR #62): linkAutoForward's check-then-act and
// resolvePendingAutoForwardForPublication's own are two separate, otherwise-unsynchronized
// statements — without serializing them against each other, they could interleave as: (1)
// linkAutoForward checks for the publication, absent; (2) the publish call commits
// external_post_id; (3) resolvePendingAutoForwardForPublication checks the pending table, ALSO
// absent (step 1 hasn't written it yet); (4) linkAutoForward (only now) writes the pending row —
// too late, nothing ever looks for it again. Fixed by running each side's whole sequence inside a
// Postgres advisory-lock transaction keyed by (projectId, externalPostId) — see the long comment
// in lib/social-comments.ts above `autoForwardLockKey`. The test below drives REAL concurrent
// requests through the actual exported functions (not a hand-simulated reordering) and asserts the
// decisive fact — the thread ends up linked, read back independently via `resolveThread` — not
// merely that neither call threw a SQL error.

test('concurrent requests: linkAutoForward and resolvePendingAutoForwardForPublication racing for the SAME post always converge on a correctly linked thread', async (t) => {
  await withDb(t, async (pool, { makeProject, makeDraftPublication, setExternalPostId }) => {
    // Several iterations, each with fresh, unique identifiers — real concurrency means the DB (not
    // this test) decides which side's lock-protected transaction actually runs first on any given
    // run, so repeating this is what gives confidence the fix holds regardless of that order, not
    // just in whichever order happened to occur on a single run.
    for (let i = 0; i < 8; i++) {
      const channelUsername = `olnoo_channel_race_${i}`
      const discussionChatId = `-100${2000 + i}`
      const messageId = String(5000 + i)

      const projectId = await makeProject(`@${channelUsername}`)
      const publicationId = await makeDraftPublication(projectId)

      // Real concurrency through two independent Postgres connections: the webhook's auto-forward
      // handling, and the publish call's own external_post_id commit immediately followed by its
      // resolve step — dispatched together via Promise.all, exactly the two sides that raced in
      // production.
      await Promise.all([
        linkAutoForward(pool, autoForward(channelUsername, messageId, discussionChatId, '555')),
        (async () => {
          await setExternalPostId(publicationId, messageId)
          return resolvePendingAutoForwardForPublication(pool, projectId, publicationId, `@${channelUsername}`, messageId)
        })(),
      ])

      // The decisive assertion: read the end state back independently. Whichever of the two calls
      // above "won" and whichever returned null proves nothing by itself (exactly one of them is
      // expected to be a no-op, depending on timing this test deliberately does not control) — only
      // the actual stored mapping does.
      const linked = await resolveThread(pool, discussionChatId, '555')
      assert.deepEqual(linked, { projectId, publicationId }, `iteration ${i}: the thread must be linked no matter which side's transaction committed first`)
    }
  })
})

test('a comment arriving before the thread links is replayed into social_comments once linkAutoForward completes the link — not lost', async (t) => {
  await withDb(t, async (pool, { makeProject, makeDraftPublication, setExternalPostId }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makeDraftPublication(projectId)

    // A viewer comments before the auto-forward has even been observed. resolveThread's 4th
    // argument is the whole point of this test: passing the event means "remember me if you can't
    // attribute me yet", instead of the comment being silently dropped forever the moment this
    // call returns null.
    const earlyComment = comment('556')
    const resolvedEarly = await resolveThread(pool, '-100111', '555', earlyComment)
    assert.equal(resolvedEarly, null, 'still genuinely unattributed at this exact moment — expected, not itself a bug')
    assert.equal((await listCommentsForProject(pool, projectId)).length, 0, 'not recorded as a real comment yet — only remembered as pending')

    // The auto-forward webhook and the publish's own external_post_id commit now both land.
    await setExternalPostId(publicationId, '8')
    const linked = await linkAutoForward(pool, autoForward('olnoo_channel', '8'))
    assert.deepEqual(linked, { projectId, publicationId })

    // The early comment must now be present — recovered, not lost — even though
    // handleTelegramCommentsUpdate reported `comment_unattributed` for its own original webhook call.
    const rows = await listCommentsForProject(pool, projectId)
    assert.equal(rows.length, 1, 'the comment that arrived before linking must have been replayed, not dropped forever')
    assert.equal(rows[0].body, 'hello')
    assert.equal(rows[0].author_username, 'tester')
  })
})

test('a comment arriving before the thread links is replayed even when the OTHER race side (resolvePendingAutoForwardForPublication) is the one that performs the link', async (t) => {
  await withDb(t, async (pool, { makeProject, makeDraftPublication, setExternalPostId }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makeDraftPublication(projectId)

    await linkAutoForward(pool, autoForward('olnoo_channel', '8')) // webhook arrives first, finds nothing yet, stores pending
    const earlyComment = comment('556')
    assert.equal(await resolveThread(pool, '-100111', '555', earlyComment), null)

    await setExternalPostId(publicationId, '8')
    const resolved = await resolvePendingAutoForwardForPublication(pool, projectId, publicationId, '@olnoo_channel', '8')
    assert.deepEqual(resolved, { projectId, publicationId })

    const rows = await listCommentsForProject(pool, projectId)
    assert.equal(rows.length, 1, 'replay must happen on this path too, not only when linkAutoForward itself performs the stamp')
    assert.equal(rows[0].body, 'hello')
  })
})

test('a comment that arrives AFTER the thread is already linked never touches the pending-comment path at all', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '42')
    await linkAutoForward(pool, autoForward('olnoo_channel', '42'))

    const resolved = await resolveThread(pool, '-100111', '555', comment('556'))
    assert.deepEqual(resolved, { projectId, publicationId }, 'resolves immediately — never needed to be remembered')
  })
})

// --- Normalization fix (requirement 2): matching must work regardless of which of the three
// equivalent-looking forms social_accounts.username happens to hold. ---

test('linkAutoForward matches even when social_accounts.username is stored WITHOUT the "@" prefix (a bare handle)', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    // Deliberately NOT using makeProject (which stores whatever string it's given) with "@" — this
    // simulates a row whose stored form differs from the always-"@"-normalized webhook candidate.
    const projectId = await makeProject('olnoo_channel')
    const publicationId = await makePublication(projectId, '42')

    const match = await linkAutoForward(pool, autoForward('olnoo_channel', '42'))
    assert.deepEqual(match, { projectId, publicationId })
  })
})

test('linkAutoForward matches a numeric chat id stored as social_accounts.username against a forward carrying only the numeric chat id (private channel, no public username)', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('-1009876543210')
    const publicationId = await makePublication(projectId, '42')

    const event: TelegramAutoForwardEvent = {
      kind: 'auto_forward',
      discussionChatId: '-100111',
      threadId: '555',
      forwardFromChatId: '-1009876543210',
      forwardFromChatUsername: '', // private channel — no public username at all
      forwardFromMessageId: '42',
    }
    const match = await linkAutoForward(pool, event)
    assert.deepEqual(match, { projectId, publicationId })
  })
})

// --- insertCommentIfNew: dedup / redelivery ---

test('insertCommentIfNew: a repeated external comment id is never inserted twice', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '42')

    const first = await insertCommentIfNew(pool, projectId, publicationId, comment('556'))
    const second = await insertCommentIfNew(pool, projectId, publicationId, comment('556')) // redelivery
    assert.equal(first.inserted, true)
    assert.deepEqual(second, { inserted: false })

    const rows = await listCommentsForProject(pool, projectId)
    assert.equal(rows.length, 1)
  })
})

test('insertCommentIfNew: two concurrent inserts for the same external id — exactly one wins', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '42')

    const results = await Promise.all([
      insertCommentIfNew(pool, projectId, publicationId, comment('556')),
      insertCommentIfNew(pool, projectId, publicationId, comment('556')),
    ])
    const winners = results.filter((r) => r.inserted)
    assert.equal(winners.length, 1, 'exactly one concurrent insert must win')

    const rows = await listCommentsForProject(pool, projectId)
    assert.equal(rows.length, 1)
  })
})

// --- Project isolation ---

test('two different projects\' identical thread ids never cross-match — each resolves to its own project only', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectA = await makeProject('@channel_a')
    const pubA = await makePublication(projectA, '1')
    const projectB = await makeProject('@channel_b')
    const pubB = await makePublication(projectB, '1')

    // Same discussion-group chat id is impossible in reality (each channel has its own group),
    // but even if two different groups happened to both use thread id 555, matching is always
    // scoped by (chat_id, thread_id) together, never thread_id alone.
    await linkAutoForward(pool, autoForward('channel_a', '1', '-100111', '555'))
    await linkAutoForward(pool, autoForward('channel_b', '1', '-100222', '555'))

    const resolvedA = await resolveThread(pool, '-100111', '555')
    const resolvedB = await resolveThread(pool, '-100222', '555')
    assert.deepEqual(resolvedA, { projectId: projectA, publicationId: pubA })
    assert.deepEqual(resolvedB, { projectId: projectB, publicationId: pubB })
  })
})

test('comments on two different projects are isolated — listCommentsForProject never returns the other project\'s rows', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectA = await makeProject('@channel_a')
    const pubA = await makePublication(projectA, '1')
    const projectB = await makeProject('@channel_b')
    const pubB = await makePublication(projectB, '1')

    await insertCommentIfNew(pool, projectA, pubA, comment('10'))
    await insertCommentIfNew(pool, projectB, pubB, comment('11'))

    const rowsA = await listCommentsForProject(pool, projectA)
    const rowsB = await listCommentsForProject(pool, projectB)
    assert.equal(rowsA.length, 1)
    assert.equal(rowsB.length, 1)
    assert.notEqual(rowsA[0].id, rowsB[0].id)
  })
})

test('a comment for a project with the SAME external_comment_id as another project is NOT deduped across projects', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectA = await makeProject('@channel_a')
    const pubA = await makePublication(projectA, '1')
    const projectB = await makeProject('@channel_b')
    const pubB = await makePublication(projectB, '1')

    const a = await insertCommentIfNew(pool, projectA, pubA, comment('777'))
    const b = await insertCommentIfNew(pool, projectB, pubB, comment('777'))
    assert.equal(a.inserted, true)
    assert.equal(b.inserted, true, 'the dedup key is scoped by project_id — the same external id in another project is a different comment')
  })
})

// --- Notification durability: listUnnotifiedComments / markCommentNotified ---

test('listUnnotifiedComments: a comment old enough with no notified_at is returned, with its project info', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '42')
    const inserted = await insertCommentIfNew(pool, projectId, publicationId, comment('556'))
    assert.equal(inserted.inserted, true)
    if (!inserted.inserted) return
    await pool.query(`UPDATE social_comments SET created_at = now() - interval '5 minutes' WHERE id = $1`, [inserted.commentId])

    const pending = await listUnnotifiedComments(pool, 2 * 60 * 1000)
    const mine = pending.find((p) => p.id === inserted.commentId)
    assert.ok(mine, 'an old, unnotified comment must be returned')
    assert.equal(mine!.projectId, projectId)
  })
})

test('listUnnotifiedComments: a comment inserted just now (within the age guard) is NOT returned yet', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '42')
    const inserted = await insertCommentIfNew(pool, projectId, publicationId, comment('556'))
    assert.equal(inserted.inserted, true)

    const pending = await listUnnotifiedComments(pool, 2 * 60 * 1000)
    assert.ok(!pending.some((p) => p.id === (inserted as { commentId: string }).commentId), 'a freshly-inserted comment must not race its own first notify attempt')
  })
})

test('markCommentNotified: once marked, a comment no longer shows up as unnotified, even if old', async (t) => {
  await withDb(t, async (pool, { makeProject, makePublication }) => {
    const projectId = await makeProject('@olnoo_channel')
    const publicationId = await makePublication(projectId, '42')
    const inserted = await insertCommentIfNew(pool, projectId, publicationId, comment('556'))
    assert.equal(inserted.inserted, true)
    if (!inserted.inserted) return
    await pool.query(`UPDATE social_comments SET created_at = now() - interval '5 minutes' WHERE id = $1`, [inserted.commentId])

    await markCommentNotified(pool, inserted.commentId)

    const pending = await listUnnotifiedComments(pool, 2 * 60 * 1000)
    assert.ok(!pending.some((p) => p.id === inserted.commentId), 'a comment already marked notified must never be retried')
  })
})
