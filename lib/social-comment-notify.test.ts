import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCommentNotification, notifyNewComment, type SendFn } from './social-comment-notify.ts'
import type { TelegramCommentEvent } from './social-telegram-comments.ts'

const PROJECT = { name: 'OLNOO', slug: 'olnoo' }

const EVENT: TelegramCommentEvent = {
  kind: 'comment',
  discussionChatId: '-100111',
  threadId: '555',
  externalCommentId: '556',
  authorName: 'Anna K',
  authorUsername: 'anna_k',
  body: 'Great post!',
  postedAt: new Date('2026-01-01T00:00:00Z'),
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(patch)) saved[k] = process.env[k]
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('formatCommentNotification includes the project name, author handle and body', () => {
  const text = formatCommentNotification(EVENT, PROJECT, null)
  assert.match(text, /Новый комментарий — OLNOO/)
  assert.ok(text.includes('От: @anna_k'))
  assert.ok(text.includes('Текст: Great post!'))
  assert.ok(text.includes('project=olnoo'))
})

test('formatCommentNotification falls back to the display name when there is no @username', () => {
  const text = formatCommentNotification({ ...EVENT, authorUsername: '' }, PROJECT, null)
  assert.ok(text.includes('От: Anna K'))
})

test('formatCommentNotification includes the post link only when one is given', () => {
  const withUrl = formatCommentNotification(EVENT, PROJECT, 'https://t.me/olnoo_channel/42')
  assert.ok(withUrl.includes('https://t.me/olnoo_channel/42'))
  const withoutUrl = formatCommentNotification(EVENT, PROJECT, null)
  assert.ok(!withoutUrl.includes('Пост:'))
})

test('a new comment -> the Telegram send function is called exactly once', async () => {
  await withEnv({ CRM_NOTIFY_TELEGRAM_CHAT_ID: '12345' }, async () => {
    let calls = 0
    const send: SendFn = async () => {
      calls++
      return { ok: true }
    }
    await notifyNewComment(EVENT, PROJECT, null, send)
    assert.equal(calls, 1)
  })
})

test('CRM_NOTIFY_TELEGRAM_CHAT_ID missing -> notification is skipped, never throws', async () => {
  await withEnv({ CRM_NOTIFY_TELEGRAM_CHAT_ID: undefined }, async () => {
    let calls = 0
    const send: SendFn = async () => {
      calls++
      return { ok: true }
    }
    await assert.doesNotReject(() => notifyNewComment(EVENT, PROJECT, null, send))
    assert.equal(calls, 0)
  })
})

test('a Telegram sendMessage error is swallowed, never thrown — the already-recorded comment is never affected by this', async () => {
  await withEnv({ CRM_NOTIFY_TELEGRAM_CHAT_ID: '12345' }, async () => {
    const send: SendFn = async () => ({ error: 'Telegram API request failed (500)' })
    await assert.doesNotReject(() => notifyNewComment(EVENT, PROJECT, null, send))
  })
})

test('send() itself throwing is also swallowed, never thrown past notifyNewComment', async () => {
  await withEnv({ CRM_NOTIFY_TELEGRAM_CHAT_ID: '12345' }, async () => {
    const send: SendFn = async () => {
      throw new Error('network died')
    }
    await assert.doesNotReject(() => notifyNewComment(EVENT, PROJECT, null, send))
  })
})
