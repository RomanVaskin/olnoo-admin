import assert from 'node:assert/strict'
import test from 'node:test'
import { notifyCrmLeadTelegram } from './crm-telegram-notify.ts'

test('skips Telegram when notification env is not configured', async () => {
  const oldToken = process.env.TELEGRAM_BOT_TOKEN
  const oldChat = process.env.CRM_TELEGRAM_CHAT_ID
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.CRM_TELEGRAM_CHAT_ID

  let called = false
  const result = await notifyCrmLeadTelegram(
    { project: 'domtrack', name: 'Roman' },
    (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  )

  if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = oldToken
  if (oldChat === undefined) delete process.env.CRM_TELEGRAM_CHAT_ID
  else process.env.CRM_TELEGRAM_CHAT_ID = oldChat

  assert.equal(result, false)
  assert.equal(called, false)
})

test('sends a compact lead copy to configured Telegram chat', async () => {
  const oldToken = process.env.TELEGRAM_BOT_TOKEN
  const oldChat = process.env.CRM_TELEGRAM_CHAT_ID
  const oldBase = process.env.TELEGRAM_API_BASE_URL
  process.env.TELEGRAM_BOT_TOKEN = 'token'
  process.env.CRM_TELEGRAM_CHAT_ID = '@olnooai'
  process.env.TELEGRAM_API_BASE_URL = 'https://telegram.test'

  let url = ''
  let init: RequestInit | undefined
  const result = await notifyCrmLeadTelegram(
    { project: 'domtrack', name: 'Roman', phone: '+70000000000', service: 'Уборка дома', source: 'Telegram' },
    (async (input, requestInit) => {
      url = String(input)
      init = requestInit
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  )

  if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = oldToken
  if (oldChat === undefined) delete process.env.CRM_TELEGRAM_CHAT_ID
  else process.env.CRM_TELEGRAM_CHAT_ID = oldChat
  if (oldBase === undefined) delete process.env.TELEGRAM_API_BASE_URL
  else process.env.TELEGRAM_API_BASE_URL = oldBase

  assert.equal(result, true)
  assert.equal(url, 'https://telegram.test/bottoken/sendMessage')
  const body = JSON.parse(String(init?.body))
  assert.equal(body.chat_id, '@olnooai')
  assert.match(body.text, /Проект: domtrack/)
  assert.match(body.text, /Уборка дома/)
})
