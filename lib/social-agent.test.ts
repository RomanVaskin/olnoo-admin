import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { runSocialAgentTask, type SocialAgentDeps, type CreatedAgentPost } from './social-agent.ts'

// DB integration (skipped without a reachable Postgres) — same convention as
// lib/social-comment-reply.test.ts. `deps` (the "adapt + create a real draft" / "delete a draft"
// step) is FAKE here — see lib/social-agent.ts's own file-level comment for why the real
// createSocialPost/generateChannelVariants (lib/social.ts/lib/social-ai.ts) cannot be loaded under
// this plain `node --test` runner at all (both transitively import `@/lib/db`). These tests
// instead prove the part that's actually new: the idempotency claim against social_agent_runs,
// project isolation, and the no-partial-set-on-failure rollback — all real behavior against a
// real Postgres, just with a fake "create the draft" step standing in for the reused functions.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(
  t: TestContext,
  fn: (
    pool: Pool,
    ctx: { makeProjectWithChannel: (platform?: string) => Promise<number> },
  ) => Promise<void>,
) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT id FROM social_agent_runs LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the social_agent_runs schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }

  const clientIds: number[] = []
  const makeProjectWithChannel = async (platform = 'telegram') => {
    const clientId = (
      await pool.query(`INSERT INTO clients (name) VALUES ('__test_social_agent__' || clock_timestamp()::text) RETURNING id`)
    ).rows[0].id as number
    clientIds.push(clientId)
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        'agent test',
        `${slug}.example`,
        slug,
      ])
    ).rows[0].id as number
    await pool.query(
      `INSERT INTO social_accounts (id, project_id, platform, name, username, status, active)
       VALUES ($1, $2, $3, 'test channel', '@test_channel', 'connected', true)`,
      [randomUUID(), projectId, platform],
    )
    return projectId
  }

  try {
    await fn(pool, { makeProjectWithChannel })
  } finally {
    for (const clientId of clientIds) {
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]) // cascades to everything
    }
    await pool.end()
  }
}

/** Scripted global fetch for the AI Router's planning call (same approach as lib/ai-router.test.ts
 * / lib/social-comment-reply.test.ts). */
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

function aiRouterOk(content: unknown): Response {
  return new Response(JSON.stringify({ id: 'r1', requestId: 'req1', provider: 'openai', model: 'gpt', content: JSON.stringify(content) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function aiRouterBadJson(): Response {
  return new Response(JSON.stringify({ id: 'r1', requestId: 'req1', provider: 'openai', model: 'gpt', content: 'not json at all' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function aiRouterHttpError(status = 500): Response {
  return new Response(JSON.stringify({ error: 'upstream failure' }), { status })
}

const SAMPLE_PLAN = [
  { topic: 'Why ceramic coating matters', body: 'A short explainer on ceramic coating benefits.', channels: ['telegram'] },
  { topic: 'Before/after polish results', body: 'Showcasing a recent polish job.', channels: ['telegram'] },
  { topic: 'Weekly maintenance tips', body: 'Quick upkeep tips for a fresh polish.', channels: ['telegram'] },
]

/** A fake `SocialAgentDeps` that tracks every post it "created" and "deleted" in-memory, so a test
 * can assert the rollback behavior precisely (every created post was also deleted) without a real
 * social_posts table. `failAtIndex`, if given, makes the Nth call to createAdaptedDraftPost throw
 * (simulating an AI Router or post-creation failure partway through the batch). `failDeleteAtIndex`,
 * if given, makes the Nth call to deletePost (0-based, in rollback order) throw instead of
 * succeeding — simulating deleteSocialPost itself failing mid-rollback. */
function makeFakeDeps(
  opts: { failAtIndex?: number; failDeleteAtIndex?: number } = {},
): SocialAgentDeps & { created: string[]; deleted: string[]; calls: number } {
  const state = { created: [] as string[], deleted: [] as string[], calls: 0, deleteCalls: 0 }
  return {
    created: state.created,
    deleted: state.deleted,
    get calls() {
      return state.calls
    },
    createAdaptedDraftPost: async (item): Promise<CreatedAgentPost> => {
      const index = state.calls
      state.calls++
      if (opts.failAtIndex === index) {
        throw new Error(`simulated failure adapting/creating post #${index}`)
      }
      const id = randomUUID()
      state.created.push(id)
      return { id, topic: item.topic, channels: item.channels }
    },
    deletePost: async (id) => {
      const index = state.deleteCalls
      state.deleteCalls++
      if (opts.failDeleteAtIndex === index) {
        throw new Error(`simulated failure deleting draft ${id}`)
      }
      state.deleted.push(id)
    },
  } as SocialAgentDeps & { created: string[]; deleted: string[]; calls: number }
}

// --- Multiple posts from one task ---

test('one text task creates several real drafts, each tied to the correct project', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    const deps = makeFakeDeps()

    const result = await withFetch(
      () => aiRouterOk(SAMPLE_PLAN),
      () => runSocialAgentTask(pool, projectId, randomUUID(), 'Подготовь три поста на неделю о полировке автомобилей для DriveSet', deps),
    )

    assert.ok('posts' in result && !result.replayed)
    if ('posts' in result && !result.replayed) {
      assert.equal(result.posts.length, 3)
      assert.equal(new Set(result.posts.map((p) => p.id)).size, 3, 'every created post must have a unique id')
    }
    assert.equal(deps.calls, 3)
    assert.equal(deps.deleted.length, 0, 'a successful run must never roll back anything')
  })
})

// --- Project isolation ---

test('project isolation: a run claimed under one project is invisible to another project using the SAME runId', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectA = await makeProjectWithChannel()
    const projectB = await makeProjectWithChannel()
    const sharedRunId = randomUUID() // simulates an (extremely unlikely) id collision across projects

    const depsA = makeFakeDeps()
    await withFetch(() => aiRouterOk(SAMPLE_PLAN), () => runSocialAgentTask(pool, projectA, sharedRunId, 'Task for project A', depsA))

    // Project B, using the identical runId, must get its OWN independent run — never see project
    // A's completed result, never be refused because of project A's row.
    const depsB = makeFakeDeps()
    const resultB = await withFetch(
      () => aiRouterOk(SAMPLE_PLAN),
      () => runSocialAgentTask(pool, projectB, sharedRunId, 'Task for project B', depsB),
    )
    assert.ok('posts' in resultB && !resultB.replayed, 'project B must run fresh, never replay project A\'s result')
    assert.equal(depsB.calls, 3, 'project B\'s own deps must actually be invoked')
  })
})

test('a project with no connected channel is refused before any AI Router call or deps invocation', async (t) => {
  await withDb(t, async (pool) => {
    // A project with NO social_accounts row at all.
    const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_social_agent_no_channel__') RETURNING id`)).rows[0]
      .id as number
    try {
      const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
      const projectId = (
        await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
          clientId,
          'no channel test',
          `${slug}.example`,
          slug,
        ])
      ).rows[0].id as number

      let fetchCalled = false
      const deps = makeFakeDeps()
      const result = await withFetch(
        () => {
          fetchCalled = true
          return aiRouterOk(SAMPLE_PLAN)
        },
        () => runSocialAgentTask(pool, projectId, randomUUID(), 'Some task', deps),
      )
      assert.equal('error' in result && result.status, 400)
      assert.equal(fetchCalled, false, 'the AI Router must never be called for a project with no connected channel')
      assert.equal(deps.calls, 0)
    } finally {
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    }
  })
})

// --- Dedup: repeated confirmation of the SAME request never creates a duplicate batch ---

test('requirement: repeating the SAME runId after a completed run replays the result, never creates a second batch', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    const runId = randomUUID()
    const deps = makeFakeDeps()

    const first = await withFetch(() => aiRouterOk(SAMPLE_PLAN), () => runSocialAgentTask(pool, projectId, runId, 'Same task text', deps))
    assert.ok('posts' in first && !first.replayed)
    const firstPostIds = 'posts' in first && !first.replayed ? first.posts.map((p) => p.id) : []

    // Repeated confirmation — simulates a double click or a resubmitted request. No scripted
    // fetch handler is even needed here: the AI Router must never be called a second time.
    let secondFetchCalled = false
    const second = await withFetch(
      () => {
        secondFetchCalled = true
        return aiRouterOk(SAMPLE_PLAN)
      },
      () => runSocialAgentTask(pool, projectId, runId, 'Same task text', deps),
    )
    assert.ok('postIds' in second && second.replayed)
    if ('postIds' in second && second.replayed) {
      assert.deepEqual(second.postIds.sort(), firstPostIds.sort(), 'a replay must report the SAME posts, never a new set')
    }
    assert.equal(secondFetchCalled, false, 'a replayed run must never call the AI Router again')
    assert.equal(deps.calls, 3, 'deps must never be invoked again for a replayed run — still only the original 3 calls')
  })
})

test('concurrent requests: two simultaneous calls with the SAME runId — exactly one actually runs the agent', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    const runId = randomUUID()
    const deps = makeFakeDeps()

    let fetchCalls = 0
    const [first, second] = await withFetch(
      () => {
        fetchCalls++
        return aiRouterOk(SAMPLE_PLAN)
      },
      () =>
        Promise.all([
          runSocialAgentTask(pool, projectId, runId, 'Concurrent attempt 1', deps),
          runSocialAgentTask(pool, projectId, runId, 'Concurrent attempt 2', deps),
        ]),
    )
    const results = [first, second]
    const winners = results.filter((r) => 'posts' in r && !r.replayed)
    // The loser can observe the race at two different points, both correct: if it reaches the
    // claim while the winner is still 'running', it is refused with 409; if the winner has already
    // committed 'completed' by the time it reaches the claim, it instead sees a legitimate replay
    // (same postIds as the winner's posts) rather than a false 409 — either way, exactly one run
    // ever actually executes, which is what this test is really asserting.
    const losers409 = results.filter((r) => 'error' in r && r.status === 409)
    const lateReplays = results.filter((r) => 'postIds' in r && r.replayed)
    assert.equal(winners.length, 1, 'exactly one concurrent call must actually run the agent')
    assert.equal(losers409.length + lateReplays.length, 1, 'the other concurrent call must be refused (409) or see a replay of the winner — never run independently')
    if (lateReplays.length === 1 && winners.length === 1) {
      const winner = winners[0] as { posts: CreatedAgentPost[] }
      const replay = lateReplays[0] as { postIds: string[] }
      assert.deepEqual(replay.postIds.sort(), winner.posts.map((p) => p.id).sort(), 'a late replay must report the SAME posts as the winner')
    }
    assert.equal(fetchCalls, 1, 'the AI Router must only ever be called once, regardless of the race')
    assert.equal(deps.calls, 3, 'deps must only ever be invoked for the one winning run')
  })
})

// --- No partial set on AI Router (or post-creation) failure ---

test('requirement: an AI Router planning failure creates zero posts, never a partial set', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    const deps = makeFakeDeps()

    const result = await withFetch(() => aiRouterHttpError(500), () => runSocialAgentTask(pool, projectId, randomUUID(), 'A task', deps))
    assert.equal('error' in result && result.status, 422)
    assert.equal(deps.calls, 0, 'planning must fail before any post is ever created')
    assert.equal(deps.created.length, 0)
  })
})

test('requirement: a plan the AI Router returns as unparseable JSON also creates zero posts', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    const deps = makeFakeDeps()

    const result = await withFetch(() => aiRouterBadJson(), () => runSocialAgentTask(pool, projectId, randomUUID(), 'A task', deps))
    assert.equal('error' in result && result.status, 422)
    assert.equal(deps.calls, 0)
  })
})

test('requirement: a failure partway through CREATING the planned posts rolls back every post already created in this run', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    const deps = makeFakeDeps({ failAtIndex: 2 }) // plan has 3 items (indices 0,1,2) — the 3rd fails

    const result = await withFetch(() => aiRouterOk(SAMPLE_PLAN), () => runSocialAgentTask(pool, projectId, randomUUID(), 'A task', deps))
    assert.equal('error' in result && result.status, 422)
    assert.equal(deps.created.length, 2, 'the first two posts were created before the failure')
    assert.equal(deps.deleted.length, 2, 'both already-created posts must be rolled back')
    assert.deepEqual(deps.created.sort(), deps.deleted.sort(), 'exactly the posts that were created must be the ones deleted — nothing left behind')
  })
})

test('requirement: when rolling back a partial batch itself fails, the run is left non-retryable rather than silently reusable', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    const runId = randomUUID()
    // Plan has 3 items; the 3rd create fails, triggering rollback of the first 2; the 1st delete
    // in that rollback itself fails (simulating deleteSocialPost erroring), leaving one post's fate
    // unconfirmed.
    const deps = makeFakeDeps({ failAtIndex: 2, failDeleteAtIndex: 0 })

    const result = await withFetch(() => aiRouterOk(SAMPLE_PLAN), () => runSocialAgentTask(pool, projectId, runId, 'A task', deps))
    assert.equal('error' in result && result.status, 500, 'an unconfirmed cleanup must never be reported as a normal, retryable 422 failure')
    assert.equal(deps.created.length, 2)
    assert.equal(deps.deleted.length, 1, 'only the one delete that succeeded is recorded as deleted')

    // A retry with the SAME runId must be refused outright — never silently allowed to run a fresh
    // batch while the earlier run's cleanup outcome is still unconfirmed (that would risk a
    // duplicate: the one post whose deletion failed may still exist as a real draft).
    let fetchCalledOnRetry = false
    const retryDeps = makeFakeDeps()
    const retried = await withFetch(
      () => {
        fetchCalledOnRetry = true
        return aiRouterOk(SAMPLE_PLAN)
      },
      () => runSocialAgentTask(pool, projectId, runId, 'A task', retryDeps),
    )
    assert.equal('error' in retried && retried.status, 409, 'a run stuck needing manual cleanup review must refuse retry, not silently proceed')
    assert.equal(fetchCalledOnRetry, false, 'the AI Router must never be called again while cleanup is unconfirmed')
    assert.equal(retryDeps.calls, 0, 'no new post may be created while the earlier batch\'s fate is unconfirmed')

    const { rows } = await pool.query<{ status: string; post_ids: string }>(
      'SELECT status, post_ids FROM social_agent_runs WHERE id = $1 AND project_id = $2',
      [runId, projectId],
    )
    assert.equal(rows[0]?.status, 'cleanup_failed', 'the row itself must record the terminal, non-retryable status for manual review')
    assert.ok(rows[0]?.post_ids, 'the post id whose deletion could not be confirmed must be recorded for manual review')
  })
})

test('a run that failed can be retried with the SAME runId, and can succeed on that retry', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    const runId = randomUUID()

    const failingDeps = makeFakeDeps({ failAtIndex: 1 })
    const failed = await withFetch(() => aiRouterOk(SAMPLE_PLAN), () => runSocialAgentTask(pool, projectId, runId, 'A task', failingDeps))
    assert.equal('error' in failed && failed.status, 422)

    const succeedingDeps = makeFakeDeps()
    const retried = await withFetch(() => aiRouterOk(SAMPLE_PLAN), () => runSocialAgentTask(pool, projectId, runId, 'A task', succeedingDeps))
    assert.ok('posts' in retried && !retried.replayed, 'a retry after a confirmed failure must be allowed and run fresh')
    if ('posts' in retried && !retried.replayed) {
      assert.equal(retried.posts.length, 3)
    }
  })
})

test('an empty task is refused before touching the database claim or the AI Router', async (t) => {
  await withDb(t, async (pool, { makeProjectWithChannel }) => {
    const projectId = await makeProjectWithChannel()
    let fetchCalled = false
    const deps = makeFakeDeps()
    const result = await withFetch(
      () => {
        fetchCalled = true
        return aiRouterOk(SAMPLE_PLAN)
      },
      () => runSocialAgentTask(pool, projectId, randomUUID(), '   ', deps),
    )
    assert.equal('error' in result && result.status, 400)
    assert.equal(fetchCalled, false)
  })
})
