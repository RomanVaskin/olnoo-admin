import test from 'node:test'
import assert from 'node:assert/strict'
import { handleTelegramCommentsUpdate, type TelegramCommentsDeps } from './telegram-comments-handler.ts'

const AUTO_FORWARD_UPDATE = {
  message: {
    message_id: 555,
    date: 1700000000,
    chat: { id: -1001111111111, type: 'supergroup' },
    is_automatic_forward: true,
    forward_from_chat: { id: -1002222222222, type: 'channel', username: 'olnoo_channel' },
    forward_from_message_id: 42,
  },
}

function commentUpdate(messageId: number, text = 'hi') {
  return {
    message: {
      message_id: messageId,
      date: 1700000100,
      chat: { id: -1001111111111, type: 'supergroup' },
      message_thread_id: 555,
      from: { id: 1, is_bot: false, first_name: 'A' },
      text,
    },
  }
}

function fakeDeps(overrides: Partial<TelegramCommentsDeps> = {}): TelegramCommentsDeps & { notified: unknown[]; inserted: unknown[] } {
  const notified: unknown[] = []
  const inserted: unknown[] = []
  const seen = new Set<string>()
  return {
    linkAutoForward: async () => ({ projectId: 1, publicationId: 'pub-1' }),
    resolveThread: async () => ({ projectId: 1, publicationId: 'pub-1' }),
    insertCommentIfNew: async (projectId, publicationId, event) => {
      const key = `${projectId}:${event.externalCommentId}`
      if (seen.has(key)) return { inserted: false }
      seen.add(key)
      const commentId = `comment-${event.externalCommentId}`
      inserted.push({ projectId, publicationId, commentId })
      return { inserted: true, commentId }
    },
    notifyNewComment: async (projectId, commentId, event) => {
      notified.push({ projectId, commentId, event })
    },
    ...overrides,
    notified,
    inserted,
  } as TelegramCommentsDeps & { notified: unknown[]; inserted: unknown[] }
}

test('an automatic forward links the thread and reports which project/publication', async () => {
  const deps = fakeDeps()
  const outcome = await handleTelegramCommentsUpdate(AUTO_FORWARD_UPDATE, deps)
  assert.deepEqual(outcome, { action: 'thread_linked', projectId: 1, publicationId: 'pub-1' })
})

test('an automatic forward for an unknown channel/publication is reported as thread_unknown, never guessed', async () => {
  const deps = fakeDeps({ linkAutoForward: async () => null })
  const outcome = await handleTelegramCommentsUpdate(AUTO_FORWARD_UPDATE, deps)
  assert.deepEqual(outcome, { action: 'thread_unknown' })
})

test('a new comment on a known thread is recorded once and notified once', async () => {
  const deps = fakeDeps()
  const outcome = await handleTelegramCommentsUpdate(commentUpdate(556), deps)
  assert.deepEqual(outcome, { action: 'comment_recorded', projectId: 1, commentId: 'comment-556' })
  assert.equal(deps.inserted.length, 1)
  assert.equal(deps.notified.length, 1)
})

// --- Deduplication / redelivery ---

test('redelivering the exact same update never inserts or notifies twice', async () => {
  const deps = fakeDeps()
  const first = await handleTelegramCommentsUpdate(commentUpdate(556), deps)
  const second = await handleTelegramCommentsUpdate(commentUpdate(556), deps) // Telegram retried the same update

  assert.equal(first.action, 'comment_recorded')
  assert.deepEqual(second, { action: 'comment_duplicate' })
  assert.equal(deps.inserted.length, 1, 'must insert exactly once')
  assert.equal(deps.notified.length, 1, 'must notify exactly once, never again for the redelivered copy')
})

test('a comment whose thread was never linked is dropped, not attributed to a guessed project', async () => {
  const deps = fakeDeps({ resolveThread: async () => null })
  const outcome = await handleTelegramCommentsUpdate(commentUpdate(556), deps)
  assert.deepEqual(outcome, { action: 'comment_unattributed' })
  assert.equal(deps.inserted.length, 0)
  assert.equal(deps.notified.length, 0)
})

test('a genuinely new, different comment on the same thread IS recorded and notified (not treated as a duplicate)', async () => {
  const deps = fakeDeps()
  await handleTelegramCommentsUpdate(commentUpdate(556, 'first'), deps)
  const outcome = await handleTelegramCommentsUpdate(commentUpdate(557, 'second'), deps)
  assert.equal(outcome.action, 'comment_recorded')
  assert.equal(deps.inserted.length, 2)
  assert.equal(deps.notified.length, 2)
})

// --- Project isolation ---

test('two different projects\' threads are resolved independently — resolveThread/insertCommentIfNew always receive the right project', async () => {
  const seenProjects: number[] = []
  const deps = fakeDeps({
    resolveThread: async (chatId, threadId) => {
      // Project resolution keyed by (chat, thread) only — simulates two projects' discussion
      // groups, each with their own thread 555.
      if (chatId === '-1001111111111') return { projectId: 1, publicationId: 'pub-a' }
      if (chatId === '-2002222222222') return { projectId: 2, publicationId: 'pub-b' }
      return null
    },
    insertCommentIfNew: async (projectId, publicationId) => {
      seenProjects.push(projectId)
      return { inserted: true, commentId: `c-${projectId}` }
    },
  })

  const projectAUpdate = commentUpdate(556)
  const projectBUpdate = {
    message: {
      message_id: 556,
      date: 1700000100,
      chat: { id: -2002222222222, type: 'supergroup' },
      message_thread_id: 555,
      from: { id: 2, is_bot: false, first_name: 'B' },
      text: 'hi from project B',
    },
  }

  const outcomeA = await handleTelegramCommentsUpdate(projectAUpdate, deps)
  const outcomeB = await handleTelegramCommentsUpdate(projectBUpdate, deps)

  assert.equal(outcomeA.action, 'comment_recorded')
  assert.equal(outcomeB.action, 'comment_recorded')
  assert.deepEqual(seenProjects, [1, 2], 'each update must resolve to its OWN project, never the other\'s')
})

test('ignored updates never reach insertCommentIfNew or notifyNewComment', async () => {
  const deps = fakeDeps()
  const outcome = await handleTelegramCommentsUpdate({ edited_message: { message_id: 1 } }, deps)
  assert.equal(outcome.action, 'ignored')
  assert.equal(deps.inserted.length, 0)
  assert.equal(deps.notified.length, 0)
})
