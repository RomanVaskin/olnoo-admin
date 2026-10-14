import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTelegramChatIdentifier, telegramIdentifiersMatch, verifyTelegramChannelAccess } from './social-telegram-verify.ts'

test('telegramIdentifiersMatch: a bare handle matches its "@handle" form', () => {
  assert.equal(telegramIdentifiersMatch('olnoo_channel', '@olnoo_channel'), true)
})

test('telegramIdentifiersMatch: case-insensitive', () => {
  assert.equal(telegramIdentifiersMatch('@Olnoo_Channel', 'olnoo_channel'), true)
})

test('telegramIdentifiersMatch: matches a numeric chat id against itself regardless of which side has it', () => {
  assert.equal(telegramIdentifiersMatch('-1009876543210', '-1009876543210'), true)
})

test('telegramIdentifiersMatch: different channels never match', () => {
  assert.equal(telegramIdentifiersMatch('@olnoo_channel', '@some_other_channel'), false)
  assert.equal(telegramIdentifiersMatch('-1009876543210', '-1001111111111'), false)
})

test('telegramIdentifiersMatch: a username never matches a numeric chat id (not the same channel representation)', () => {
  assert.equal(telegramIdentifiersMatch('@olnoo_channel', '-1009876543210'), false)
})

test('telegramIdentifiersMatch: two blank identifiers never match — unset must never equal unset', () => {
  assert.equal(telegramIdentifiersMatch('', ''), false)
  assert.equal(telegramIdentifiersMatch('  ', ''), false)
})

/** Scripted global fetch (same approach as yandex-direct.test.ts / social-vk-verify.test.ts). */
async function withFetch<T>(handler: (url: string) => Response | Error, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const out = handler(String(url))
    if (out instanceof Error) throw out
    return out
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function errorResponse(description: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, description }), { status, headers: { 'Content-Type': 'application/json' } })
}

test('normalizeTelegramChatIdentifier: adds "@" to a bare handle, leaves "@handle" and numeric ids alone', () => {
  assert.equal(normalizeTelegramChatIdentifier('my_channel'), '@my_channel')
  assert.equal(normalizeTelegramChatIdentifier('@my_channel'), '@my_channel')
  assert.equal(normalizeTelegramChatIdentifier('-1001234567890'), '-1001234567890')
  assert.equal(normalizeTelegramChatIdentifier('  my_channel  '), '@my_channel')
})

function scriptedCalls(responses: { getMe?: Response | Error; getChat?: Response | Error; getChatMember?: Response | Error }) {
  return (url: string) => {
    if (url.includes('/getMe')) return responses.getMe ?? errorResponse('unexpected getMe call')
    if (url.includes('/getChat?')) return responses.getChat ?? errorResponse('unexpected getChat call')
    if (url.includes('/getChatMember')) return responses.getChatMember ?? errorResponse('unexpected getChatMember call')
    return errorResponse('unexpected call: ' + url)
  }
}

test('bot is channel creator → verified, even though can_post_messages is not applicable to a creator', async () => {
  const result = await withFetch(
    scriptedCalls({
      getMe: okResponse({ id: 999, is_bot: true }),
      getChat: okResponse({ id: -100123, type: 'channel', title: 'DriveSet News', username: 'driveset_news' }),
      getChatMember: okResponse({ status: 'creator' }),
    }),
    () => verifyTelegramChannelAccess('bot-token', 'driveset_news'),
  )
  assert.deepEqual(result, { ok: true, identity: { chatId: '-100123', title: 'DriveSet News', username: 'driveset_news' } })
})

test('bot is administrator with posting rights → verified', async () => {
  const result = await withFetch(
    scriptedCalls({
      getMe: okResponse({ id: 999 }),
      getChat: okResponse({ id: -100456, type: 'channel', title: 'Aura Updates', username: 'aura_updates' }),
      getChatMember: okResponse({ status: 'administrator', can_post_messages: true }),
    }),
    () => verifyTelegramChannelAccess('bot-token', '@aura_updates'),
  )
  assert.equal(result.ok, true)
})

test('bot is administrator WITHOUT posting rights → rejected, never assumed to be able to post', async () => {
  const result = await withFetch(
    scriptedCalls({
      getMe: okResponse({ id: 999 }),
      getChat: okResponse({ id: -100456, type: 'channel', title: 'Aura Updates', username: 'aura_updates' }),
      getChatMember: okResponse({ status: 'administrator', can_post_messages: false }),
    }),
    () => verifyTelegramChannelAccess('bot-token', '@aura_updates'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /not an admin with posting rights/.test(result.error))
})

test('bot is only a regular member (not admin) → rejected', async () => {
  const result = await withFetch(
    scriptedCalls({
      getMe: okResponse({ id: 999 }),
      getChat: okResponse({ id: -100456, type: 'channel', title: 'Aura Updates', username: 'aura_updates' }),
      getChatMember: okResponse({ status: 'member' }),
    }),
    () => verifyTelegramChannelAccess('bot-token', '@aura_updates'),
  )
  assert.equal(result.ok, false)
})

test('bot was never added to the chat at all (getChatMember errors) → rejected, not silently connected', async () => {
  const result = await withFetch(
    scriptedCalls({
      getMe: okResponse({ id: 999 }),
      getChat: okResponse({ id: -100456, type: 'channel', title: 'Aura Updates', username: 'aura_updates' }),
      getChatMember: errorResponse('Bad Request: user not found', 400),
    }),
    () => verifyTelegramChannelAccess('bot-token', '@aura_updates'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('user not found'))
})

test('a group or private chat (not a channel) is rejected — this task is specifically about channels', async () => {
  const result = await withFetch(
    scriptedCalls({
      getMe: okResponse({ id: 999 }),
      getChat: okResponse({ id: -200, type: 'supergroup', title: 'Some Group' }),
    }),
    () => verifyTelegramChannelAccess('bot-token', 'some_group'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /not a channel/.test(result.error))
})

test('an unresolvable chat_id (getChat errors) is surfaced as an error, not guessed as connected', async () => {
  const result = await withFetch(
    scriptedCalls({
      getMe: okResponse({ id: 999 }),
      getChat: errorResponse('Bad Request: chat not found', 400),
    }),
    () => verifyTelegramChannelAccess('bot-token', 'no_such_channel'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('chat not found'))
})

test('a network failure is surfaced as an error, not thrown past the caller', async () => {
  const result = await withFetch(
    scriptedCalls({ getMe: new Error('getaddrinfo ENOTFOUND api.telegram.org') }),
    () => verifyTelegramChannelAccess('bot-token', 'any_channel'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('ENOTFOUND'))
})
