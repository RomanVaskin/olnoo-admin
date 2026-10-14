import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTelegramCommentsUpdate } from './social-telegram-comments.ts'

test('an automatic forward of a channel post into the discussion group is recognized', () => {
  const decision = classifyTelegramCommentsUpdate({
    update_id: 1,
    message: {
      message_id: 555,
      date: 1700000000,
      chat: { id: -1001111111111, type: 'supergroup', title: 'OLNOO Discussion' },
      is_automatic_forward: true,
      forward_from_chat: { id: -1002222222222, type: 'channel', title: 'OLNOO', username: 'olnoo_channel' },
      forward_from_message_id: 42,
    },
  })
  assert.deepEqual(decision, {
    kind: 'auto_forward',
    discussionChatId: '-1001111111111',
    threadId: '555',
    forwardFromChatId: '-1002222222222',
    forwardFromChatUsername: 'olnoo_channel',
    forwardFromMessageId: '42',
  })
})

test('a plain comment reply inside an established thread is recognized', () => {
  const decision = classifyTelegramCommentsUpdate({
    update_id: 2,
    message: {
      message_id: 556,
      date: 1700000100,
      chat: { id: -1001111111111, type: 'supergroup' },
      message_thread_id: 555,
      from: { id: 999, is_bot: false, first_name: 'Anna', last_name: 'K', username: 'anna_k' },
      text: 'Great post!',
    },
  })
  assert.equal(decision.kind, 'comment')
  if (decision.kind === 'comment') {
    assert.equal(decision.discussionChatId, '-1001111111111')
    assert.equal(decision.threadId, '555')
    assert.equal(decision.externalCommentId, '556')
    assert.equal(decision.authorName, 'Anna K')
    assert.equal(decision.authorUsername, 'anna_k')
    assert.equal(decision.body, 'Great post!')
    assert.equal(decision.postedAt.getTime(), 1700000100 * 1000)
  }
})

test('a caption is used as the comment body when there is no text (e.g. a photo comment)', () => {
  const decision = classifyTelegramCommentsUpdate({
    message: {
      message_id: 557,
      date: 1700000200,
      chat: { id: -1001111111111, type: 'supergroup' },
      message_thread_id: 555,
      caption: 'nice photo',
    },
  })
  assert.equal(decision.kind, 'comment')
  if (decision.kind === 'comment') assert.equal(decision.body, 'nice photo')
})

test('a message with no thread at all (not a comment) is ignored, not guessed', () => {
  const decision = classifyTelegramCommentsUpdate({
    message: { message_id: 558, date: 1700000300, chat: { id: -1001111111111, type: 'supergroup' }, text: 'hello group' },
  })
  assert.equal(decision.kind, 'ignore')
})

test('a message outside any supergroup (e.g. a private chat or the channel itself) is ignored', () => {
  const decision = classifyTelegramCommentsUpdate({
    message: { message_id: 1, date: 1700000000, chat: { id: 123, type: 'private' }, text: 'hi' },
  })
  assert.equal(decision.kind, 'ignore')
})

test('a bot\'s own message is ignored', () => {
  const decision = classifyTelegramCommentsUpdate({
    message: {
      message_id: 559,
      date: 1700000400,
      chat: { id: -1001111111111, type: 'supergroup' },
      message_thread_id: 555,
      from: { id: 1, is_bot: true, first_name: 'SomeBot' },
      text: 'beep boop',
    },
  })
  assert.equal(decision.kind, 'ignore')
})

test('a non-message update (e.g. edited_message, callback_query) is ignored', () => {
  assert.equal(classifyTelegramCommentsUpdate({ edited_message: { message_id: 1 } }).kind, 'ignore')
  assert.equal(classifyTelegramCommentsUpdate({ callback_query: { id: 'x' } }).kind, 'ignore')
  assert.equal(classifyTelegramCommentsUpdate(null).kind, 'ignore')
  assert.equal(classifyTelegramCommentsUpdate({}).kind, 'ignore')
})

test('an automatic forward missing an id this feature needs is ignored, not guessed', () => {
  const decision = classifyTelegramCommentsUpdate({
    message: {
      message_id: 560,
      date: 1700000500,
      chat: { id: -1001111111111, type: 'supergroup' },
      is_automatic_forward: true,
      // forward_from_chat missing entirely
      forward_from_message_id: 42,
    },
  })
  assert.equal(decision.kind, 'ignore')
})
