import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { handleTelegramBusinessUpdate, isValidWebhookSecret, telegramBusinessConfig } from './telegram-business.ts'

const OWNER = '1000'
const config = { token: 'tok', secret: 'sekret', ownerUserId: OWNER, project: 'driveset' }

function businessMessage(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    business_message: {
      message_id: 10,
      business_connection_id: 'conn-1',
      date: 1790000000,
      chat: { id: 2000, type: 'private' },
      from: { id: 2000, is_bot: false, first_name: 'Иван', last_name: 'Петров', username: 'ivan_p' },
      text: 'Здравствуйте, сколько стоит PPF на Camry?',
      ...overrides,
    },
  }
}

// Patch A regression: a personal Telegram Business message must be accepted and classified by
// the webhook, but must end as "ignored" — no CRM lead, no tg:<id>, no sender name, no message
// text stored. Before this patch, the same input reached findOrCreateTelegramLead → createLeadRecord.
test('an incoming private business_message is accepted but ends as ignored (no lead)', async () => {
  const outcome = await handleTelegramBusinessUpdate(businessMessage(), config)
  assert.deepEqual(outcome, {
    action: 'ignored',
    reason: 'incoming business messages no longer create leads (disabled)',
  })
})

test('a business_message from the connected owner (manager\'s own reply) is still ignored', async () => {
  const outcome = await handleTelegramBusinessUpdate(
    businessMessage({ chat: { id: Number(OWNER), type: 'private' }, from: { id: Number(OWNER), is_bot: false } }),
    config,
  )
  assert.equal(outcome.action, 'ignored')
})

test('an unrelated/malformed update is still ignored, same as before', async () => {
  const outcome = await handleTelegramBusinessUpdate({ update_id: 2, message: { text: 'not a business update' } }, config)
  assert.equal(outcome.action, 'ignored')
})

// business_connection handling is unrelated to lead creation and is unaffected by Patch A.
test('a business_connection update from the configured owner is still classified as "connection"', async () => {
  const outcome = await handleTelegramBusinessUpdate(
    {
      update_id: 3,
      business_connection: { id: 'conn-1', user: { id: Number(OWNER) }, is_enabled: true },
    },
    config,
  )
  assert.deepEqual(outcome, { action: 'connection', enabled: true })
})

test('telegramBusinessConfig / isValidWebhookSecret are unaffected by Patch A', () => {
  const previous = { ...process.env }
  process.env.TELEGRAM_BUSINESS_BOT_TOKEN = 'tok'
  process.env.TELEGRAM_BUSINESS_WEBHOOK_SECRET = 'sekret'
  process.env.TELEGRAM_BUSINESS_OWNER_USER_ID = OWNER
  process.env.TELEGRAM_BUSINESS_PROJECT = 'driveset'
  try {
    assert.deepEqual(telegramBusinessConfig(), { token: 'tok', secret: 'sekret', ownerUserId: OWNER, project: 'driveset' })
  } finally {
    process.env = previous
  }
  assert.equal(isValidWebhookSecret('sekret', 'sekret'), true)
  assert.equal(isValidWebhookSecret('wrong', 'sekret'), false)
  assert.equal(isValidWebhookSecret(null, 'sekret'), false)
})

// Static regression guard, independent of DB reachability in CI: if createLeadRecord (or the
// now-removed findOrCreateTelegramLead/pool import) is ever reintroduced on the incoming-message
// path, this fails immediately — the outcome-shape assertions above alone wouldn't catch a call
// that's made but whose result is then discarded.
test('lib/telegram-business.ts no longer references createLeadRecord or a DB pool', async () => {
  const source = await readFile(new URL('./telegram-business.ts', import.meta.url), 'utf8')
  assert.ok(!source.includes('createLeadRecord'), 'createLeadRecord must not be called from telegram-business.ts')
  assert.ok(!source.includes('@/lib/db'), 'telegram-business.ts must not import the DB pool')
  assert.ok(!source.includes('@/lib/crm'), 'telegram-business.ts must not import CRM write helpers')
})
