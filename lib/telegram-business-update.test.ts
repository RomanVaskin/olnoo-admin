import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTelegramBusinessUpdate, telegramContactKey, telegramLeadMessage } from './telegram-business-update.ts'

const OWNER = '1000'
const client = { id: 2000, is_bot: false, first_name: 'Иван', last_name: 'Петров', username: 'ivan_p' }

function businessMessage(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    business_message: {
      message_id: 10,
      business_connection_id: 'conn-1',
      date: 1790000000,
      chat: { id: 2000, type: 'private' },
      from: client,
      text: 'Здравствуйте, сколько стоит PPF на Camry?',
      ...overrides,
    },
  }
}

test('a client message in a business chat is an incoming lead candidate', () => {
  assert.deepEqual(classifyTelegramBusinessUpdate(businessMessage(), OWNER), {
    kind: 'incoming',
    connectionId: 'conn-1',
    telegramUserId: '2000',
    username: 'ivan_p',
    displayName: 'Иван Петров',
    firstMessage: 'Здравствуйте, сколько стоит PPF на Camry?',
  })
})

test("the owner's own outgoing message is ignored", () => {
  const update = businessMessage({ from: { id: 1000, is_bot: false, first_name: 'DriveSet' } })
  assert.equal(classifyTelegramBusinessUpdate(update, OWNER).kind, 'ignore')
})

test('bots, non-private chats and malformed messages are ignored', () => {
  assert.equal(classifyTelegramBusinessUpdate(businessMessage({ from: { ...client, is_bot: true } }), OWNER).kind, 'ignore')
  assert.equal(classifyTelegramBusinessUpdate(businessMessage({ chat: { id: -5, type: 'group' } }), OWNER).kind, 'ignore')
  assert.equal(classifyTelegramBusinessUpdate(businessMessage({ chat: { id: 3000, type: 'private' } }), OWNER).kind, 'ignore')
  assert.equal(classifyTelegramBusinessUpdate(businessMessage({ from: undefined }), OWNER).kind, 'ignore')
  assert.equal(classifyTelegramBusinessUpdate(businessMessage({ business_connection_id: undefined }), OWNER).kind, 'ignore')
  assert.equal(classifyTelegramBusinessUpdate(null, OWNER).kind, 'ignore')
})

test('edits, deletions and ordinary bot updates are ignored', () => {
  const edited = { update_id: 2, edited_business_message: businessMessage().business_message }
  const deleted = { update_id: 3, deleted_business_messages: { business_connection_id: 'conn-1', chat: { id: 2000, type: 'private' }, message_ids: [10] } }
  const plain = { update_id: 4, message: businessMessage().business_message }
  for (const update of [edited, deleted, plain]) {
    assert.equal(classifyTelegramBusinessUpdate(update, OWNER).kind, 'ignore')
  }
})

test('a business_connection update reports owner and enabled state', () => {
  const update = { update_id: 5, business_connection: { id: 'conn-1', user: { id: 1000, first_name: 'DriveSet' }, user_chat_id: 1000, date: 1, is_enabled: true } }
  assert.deepEqual(classifyTelegramBusinessUpdate(update, OWNER), { kind: 'connection', connectionId: 'conn-1', ownerUserId: '1000', enabled: true })
})

test('display name falls back to @username, then to the numeric id', () => {
  const noName = classifyTelegramBusinessUpdate(businessMessage({ from: { id: 2000, is_bot: false, first_name: ' ', username: 'ivan_p' } }), OWNER)
  assert.equal(noName.kind === 'incoming' && noName.displayName, '@ivan_p')
  const bare = classifyTelegramBusinessUpdate(businessMessage({ from: { id: 2000, is_bot: false } }), OWNER)
  assert.equal(bare.kind === 'incoming' && bare.displayName, 'Telegram 2000')
})

test('media without text gets a placeholder, a caption is kept, long text is truncated', () => {
  const photo = classifyTelegramBusinessUpdate(businessMessage({ text: undefined, photo: [{}] }), OWNER)
  assert.equal(photo.kind === 'incoming' && photo.firstMessage, '[фото]')
  const captioned = classifyTelegramBusinessUpdate(businessMessage({ text: undefined, photo: [{}], caption: 'вот скол' }), OWNER)
  assert.equal(captioned.kind === 'incoming' && captioned.firstMessage, '[фото] вот скол')
  const long = classifyTelegramBusinessUpdate(businessMessage({ text: 'а'.repeat(5000) }), OWNER)
  assert.equal(long.kind === 'incoming' && long.firstMessage.length, 2001)
})

test('dedup key and lead message use the numeric id', () => {
  assert.equal(telegramContactKey('2000'), 'tg:2000')
  assert.equal(
    telegramLeadMessage({ username: 'ivan_p', telegramUserId: '2000', firstMessage: 'Привет' }),
    'Прямое обращение в Telegram (@ivan_p, id 2000).\nПервое сообщение: Привет',
  )
  assert.match(telegramLeadMessage({ username: '', telegramUserId: '2000', firstMessage: 'x' }), /без username/)
})
