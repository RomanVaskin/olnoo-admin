import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { handleTelegramBusinessUpdate, isValidWebhookSecret, telegramBusinessConfig, type TelegramBusinessDeps } from './telegram-business.ts'
import { insertLead } from './lead-insert.ts'
import { parseLeadAttribution } from './lead-attribution.ts'

const OWNER = '1000'
const DRIVESET_CONNECTION = 'conn-driveset'
const config = { token: 'tok', secret: 'sekret', ownerUserId: OWNER, project: 'driveset', driveSetConnectionId: DRIVESET_CONNECTION }
// Same config but as if TELEGRAM_BUSINESS_DRIVESET_CONNECTION_ID were unset — must fail closed.
const configNoDriveSet = { ...config, driveSetConnectionId: '' }

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

// A deps fixture whose createLead/resolveProjectId must never be called for an "ignored" outcome —
// calling either is itself a test failure, since it would mean a lead was (or could have been)
// touched for an update this patch must not act on.
const unusedDeps: TelegramBusinessDeps = {
  pool: new Pool({ connectionString: 'postgresql://unused/unused' }),
  resolveProjectId: async () => {
    throw new Error('resolveProjectId must not be called for an ignored update')
  },
  createLead: async () => {
    throw new Error('createLead must not be called for an ignored update')
  },
}

// Patch A regression: a business_connection_id OTHER than the configured DriveSet one must still
// be accepted and classified by the webhook, but must end as "ignored" — no CRM lead, nothing
// stored. Before Patch D, every connection reached this same "disabled" outcome.
test('an incoming private business_message on a DIFFERENT connection is accepted but ends as ignored (no lead)', async () => {
  const outcome = await handleTelegramBusinessUpdate(businessMessage(), config, unusedDeps)
  assert.deepEqual(outcome, {
    action: 'ignored',
    reason: 'incoming business messages no longer create leads (disabled)',
  })
})

test('a business_message from the connected owner (manager\'s own reply) is still ignored, even on the DriveSet connection', async () => {
  const outcome = await handleTelegramBusinessUpdate(
    businessMessage({
      business_connection_id: DRIVESET_CONNECTION,
      chat: { id: Number(OWNER), type: 'private' },
      from: { id: Number(OWNER), is_bot: false },
    }),
    config,
    unusedDeps,
  )
  assert.equal(outcome.action, 'ignored')
})

test('a business_message from a bot is ignored, even on the DriveSet connection', async () => {
  const outcome = await handleTelegramBusinessUpdate(
    businessMessage({
      business_connection_id: DRIVESET_CONNECTION,
      chat: { id: 3000, type: 'private' },
      from: { id: 3000, is_bot: true, first_name: 'Bot' },
    }),
    config,
    unusedDeps,
  )
  assert.equal(outcome.action, 'ignored')
})

test('an unrelated/malformed update is still ignored, same as before', async () => {
  const outcome = await handleTelegramBusinessUpdate({ update_id: 2, message: { text: 'not a business update' } }, config, unusedDeps)
  assert.equal(outcome.action, 'ignored')
})

// business_connection handling is unrelated to lead creation and is unaffected by Patch A/D.
test('a business_connection update from the configured owner is still classified as "connection"', async () => {
  const outcome = await handleTelegramBusinessUpdate(
    {
      update_id: 3,
      business_connection: { id: 'conn-1', user: { id: Number(OWNER) }, is_enabled: true },
    },
    config,
    unusedDeps,
  )
  assert.deepEqual(outcome, { action: 'connection', enabled: true })
})

test('TELEGRAM_BUSINESS_DRIVESET_CONNECTION_ID missing/empty -> the DriveSet connection itself is ignored too (fail closed, never fail open)', async () => {
  const outcome = await handleTelegramBusinessUpdate(
    businessMessage({
      business_connection_id: DRIVESET_CONNECTION,
      chat: { id: 4000, type: 'private' },
      from: { id: 4000, is_bot: false, first_name: 'Клиент' },
    }),
    configNoDriveSet,
    unusedDeps,
  )
  assert.deepEqual(outcome, {
    action: 'ignored',
    reason: 'incoming business messages no longer create leads (disabled)',
  })
})

test('telegramBusinessConfig / isValidWebhookSecret are unaffected by Patch D', () => {
  const previous = { ...process.env }
  process.env.TELEGRAM_BUSINESS_BOT_TOKEN = 'tok'
  process.env.TELEGRAM_BUSINESS_WEBHOOK_SECRET = 'sekret'
  process.env.TELEGRAM_BUSINESS_OWNER_USER_ID = OWNER
  process.env.TELEGRAM_BUSINESS_PROJECT = 'driveset'
  delete process.env.TELEGRAM_BUSINESS_DRIVESET_CONNECTION_ID
  try {
    assert.deepEqual(telegramBusinessConfig(), { token: 'tok', secret: 'sekret', ownerUserId: OWNER, project: 'driveset', driveSetConnectionId: '' })
    process.env.TELEGRAM_BUSINESS_DRIVESET_CONNECTION_ID = DRIVESET_CONNECTION
    assert.deepEqual(telegramBusinessConfig(), { token: 'tok', secret: 'sekret', ownerUserId: OWNER, project: 'driveset', driveSetConnectionId: DRIVESET_CONNECTION })
  } finally {
    process.env = previous
  }
  assert.equal(isValidWebhookSecret('sekret', 'sekret'), true)
  assert.equal(isValidWebhookSecret('wrong', 'sekret'), false)
  assert.equal(isValidWebhookSecret(null, 'sekret'), false)
})

// --- DB-backed tests: the DriveSet connection is the only path that reaches the DB. Uses a real
// Postgres (same skip-if-unreachable pattern as lib/lead-insert.test.ts), with a `createLead`
// fake that inserts via the already-tested lib/lead-insert.ts directly — proving the real
// find-or-create/advisory-lock path end to end without depending on `@/lib/crm`.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'
const dbPool = new Pool({ connectionString: DATABASE_URL })

async function dbDeps(t: TestContext): Promise<TelegramBusinessDeps | null> {
  try {
    await dbPool.query('SELECT channel FROM leads LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migration 0020 (leads.channel) at DATABASE_URL — skipping (${(err as Error).message})`)
    return null
  }
  return {
    pool: dbPool,
    resolveProjectId: async (slug) => {
      const { rows } = await dbPool.query<{ id: number }>('SELECT id FROM projects WHERE slug = $1', [slug])
      return rows[0]?.id ?? null
    },
    createLead: async (input, client: PoolClient) => {
      const attribution = parseLeadAttribution({})
      assert.ok(!('error' in attribution))
      const projectId = (await dbPool.query<{ id: number }>('SELECT id FROM projects WHERE slug = $1', [input.project])).rows[0].id
      const result = await insertLead(client, {
        id: randomUUID(),
        projectId,
        name: input.name,
        company: '',
        email: '',
        service: '',
        message: input.message,
        source: input.source,
        channel: input.channel,
        notes: '',
        phone: null,
        contact: input.contact,
        landingPage: '',
        pagePath: '',
        referrer: '',
        locale: '',
        utmSource: '',
        utmMedium: '',
        utmCampaign: '',
        utmContent: '',
        utmTerm: '',
        attribution,
      })
      assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
      return String((result as { row: Record<string, unknown> }).row.id)
    },
  }
}

function newTelegramUserId(): number {
  return 900_000_000 + Math.floor(Math.random() * 99_999_999)
}

async function deleteLeadsFor(contact: string) {
  await dbPool.query('DELETE FROM leads WHERE contact = $1', [contact])
}

test('DriveSet connection + new external user -> exactly one lead is created (project=driveset, channel=Telegram, contact=tg:<id>)', async (t) => {
  const deps = await dbDeps(t)
  if (!deps) return
  const telegramUserId = newTelegramUserId()
  const contact = `tg:${telegramUserId}`
  await deleteLeadsFor(contact)
  try {
    const outcome = await handleTelegramBusinessUpdate(
      businessMessage({
        business_connection_id: DRIVESET_CONNECTION,
        chat: { id: telegramUserId, type: 'private' },
        from: { id: telegramUserId, is_bot: false, first_name: 'Новый', last_name: 'Клиент', username: 'new_client' },
      }),
      config,
      deps,
    )
    assert.equal(outcome.action, 'lead_created')

    const { rows } = await dbPool.query(
      'SELECT l.channel, l.source, l.contact, p.slug FROM leads l JOIN projects p ON p.id = l.project_id WHERE l.contact = $1',
      [contact],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].slug, 'driveset')
    assert.equal(rows[0].channel, 'Telegram')
    assert.equal(rows[0].source, 'Direct')
    assert.equal(rows[0].contact, contact)
  } finally {
    await deleteLeadsFor(contact)
  }
})

test('a repeat message from the same Telegram user does not create a second lead', async (t) => {
  const deps = await dbDeps(t)
  if (!deps) return
  const telegramUserId = newTelegramUserId()
  const contact = `tg:${telegramUserId}`
  await deleteLeadsFor(contact)
  try {
    const message = () =>
      businessMessage({
        business_connection_id: DRIVESET_CONNECTION,
        chat: { id: telegramUserId, type: 'private' },
        from: { id: telegramUserId, is_bot: false, first_name: 'Повтор' },
      })

    const first = await handleTelegramBusinessUpdate(message(), config, deps)
    assert.equal(first.action, 'lead_created')
    assert.ok('leadId' in first)

    const second = await handleTelegramBusinessUpdate(message(), config, deps)
    assert.equal(second.action, 'lead_exists')
    assert.ok('leadId' in second)
    assert.equal(second.leadId, first.leadId)

    const { rows } = await dbPool.query('SELECT count(*) FROM leads WHERE contact = $1', [contact])
    assert.equal(Number(rows[0].count), 1)
  } finally {
    await deleteLeadsFor(contact)
  }
})
