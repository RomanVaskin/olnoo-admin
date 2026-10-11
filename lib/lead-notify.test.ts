import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatLeadNotification, notifyLeadCreated, shouldNotifyLeadCreation, type SendFn } from './lead-notify.ts'

const PROJECT = { name: 'DriveSet', slug: 'driveset' }

test('a new lead (replay: false) -> createLeadRecord would notify exactly once', () => {
  let calls = 0
  if (shouldNotifyLeadCreation({ replay: false })) calls++
  assert.equal(calls, 1)
})

test('a replay of the same lead_tracking_id (replay: true) -> createLeadRecord would NOT notify', () => {
  let calls = 0
  if (shouldNotifyLeadCreation({ replay: true })) calls++
  assert.equal(calls, 0)
})

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

test('formatLeadNotification contains the Project name', () => {
  const text = formatLeadNotification({ name: 'Ivan', phone: '+70000000000' }, PROJECT)
  assert.match(text, /Новый лид — DriveSet/)
})

test('formatLeadNotification never prints a line for an empty field', () => {
  const text = formatLeadNotification({ name: 'Ivan', service: '', source: '', phone: '+70000000000' }, PROJECT)
  assert.ok(!text.includes('Услуга:'))
  assert.ok(!text.includes('Источник:'))
  assert.ok(text.includes('Имя: Ivan'))
  assert.ok(text.includes('Контакт: +70000000000'))
  assert.ok(text.includes('project=driveset'))
})

test('formatLeadNotification falls back phone -> email -> contact for the Контакт line', () => {
  const text = formatLeadNotification({ name: 'Ivan', email: 'a@b.com', contact: 'tg:@ivan' }, PROJECT)
  assert.ok(text.includes('Контакт: a@b.com'))
})

test('formatLeadNotification includes "Канал: <channel>" only when channel is set', () => {
  const withChannel = formatLeadNotification({ name: 'Ivan', phone: '+70000000000', channel: 'Quiz' }, PROJECT)
  assert.ok(withChannel.includes('Канал: Quiz'))

  const withoutChannel = formatLeadNotification({ name: 'Ivan', phone: '+70000000000' }, PROJECT)
  assert.ok(!withoutChannel.includes('Канал:'))
})

test('a new lead -> the Telegram send function is called exactly once', async () => {
  await withEnv({ CRM_NOTIFY_TELEGRAM_CHAT_ID: '12345' }, async () => {
    let calls = 0
    const send: SendFn = async () => {
      calls++
      return { ok: true }
    }
    await notifyLeadCreated({ name: 'Ivan', phone: '+70000000000' }, PROJECT, send)
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
    await assert.doesNotReject(() => notifyLeadCreated({ name: 'Ivan', phone: '+70000000000' }, PROJECT, send))
    assert.equal(calls, 0)
  })
})

test('a Telegram sendMessage error is swallowed, never thrown', async () => {
  await withEnv({ CRM_NOTIFY_TELEGRAM_CHAT_ID: '12345' }, async () => {
    const send: SendFn = async () => ({ error: 'Telegram API request failed (500)' })
    await assert.doesNotReject(() => notifyLeadCreated({ name: 'Ivan', phone: '+70000000000' }, PROJECT, send))
  })
})

test('a thrown/rejected send (Telegram API unreachable) is swallowed, never thrown outward', async () => {
  await withEnv({ CRM_NOTIFY_TELEGRAM_CHAT_ID: '12345' }, async () => {
    const send: SendFn = async () => {
      throw new Error('network down')
    }
    await assert.doesNotReject(() => notifyLeadCreated({ name: 'Ivan', phone: '+70000000000' }, PROJECT, send))
  })
})
