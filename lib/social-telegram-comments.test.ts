import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTelegramCommentsUpdate } from './social-telegram-comments.ts'

// --- forward_origin (current Bot API, >= 7.0) vs. the legacy forward_from_chat shape ---

test('an automatic forward using the CURRENT forward_origin shape (MessageOriginChannel) is recognized', () => {
  const decision = classifyTelegramCommentsUpdate({
    update_id: 1,
    message: {
      message_id: 555,
      date: 1700000000,
      chat: { id: -1001111111111, type: 'supergroup', title: 'OLNOO Discussion' },
      is_automatic_forward: true,
      forward_origin: {
        type: 'channel',
        date: 1699999000,
        chat: { id: -1002222222222, type: 'channel', title: 'OLNOO', username: 'olnoo_channel' },
        message_id: 42,
      },
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

test('an automatic forward using the LEGACY forward_from_chat/forward_from_message_id shape (deprecated since Bot API 7.0, but still sent for back-compat) is still recognized', () => {
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

test('when BOTH shapes are present, forward_origin wins (the current, non-deprecated field)', () => {
  const decision = classifyTelegramCommentsUpdate({
    message: {
      message_id: 555,
      date: 1700000000,
      chat: { id: -1001111111111, type: 'supergroup' },
      is_automatic_forward: true,
      forward_origin: { type: 'channel', date: 1699999000, chat: { id: -1002222222222, username: 'olnoo_channel' }, message_id: 42 },
      // Stale/mismatched legacy fields must never override the current shape.
      forward_from_chat: { id: -1009999999999, username: 'some_other_channel' },
      forward_from_message_id: 999,
    },
  })
  assert.equal(decision.kind, 'auto_forward')
  if (decision.kind === 'auto_forward') {
    assert.equal(decision.forwardFromChatId, '-1002222222222')
    assert.equal(decision.forwardFromMessageId, '42')
  }
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

// --- Thread-id resolution: do not assume message_thread_id is always set ---

test('a direct reply to the auto-forwarded post itself, with NO message_thread_id set, is still recognized via reply_to_message.is_automatic_forward', () => {
  // Realistic shape some clients/edge cases can produce for the very first comment on a post.
  const decision = classifyTelegramCommentsUpdate({
    update_id: 10,
    message: {
      message_id: 556,
      date: 1700000100,
      chat: { id: -1001111111111, type: 'supergroup' },
      from: { id: 999, is_bot: false, first_name: 'Anna', username: 'anna_k' },
      text: 'First comment!',
      reply_to_message: {
        message_id: 555,
        is_automatic_forward: true,
        forward_origin: { type: 'channel', date: 1699999000, chat: { id: -1002222222222, username: 'olnoo_channel' }, message_id: 42 },
      },
    },
  })
  assert.equal(decision.kind, 'comment')
  if (decision.kind === 'comment') {
    assert.equal(decision.threadId, '555', 'must anchor the thread by the auto-forwarded root’s own message_id')
    assert.equal(decision.externalCommentId, '556')
  }
})

test('a reply to ANOTHER comment (reply-to-a-reply), with no message_thread_id of its own, inherits the thread via reply_to_message.message_thread_id', () => {
  const decision = classifyTelegramCommentsUpdate({
    update_id: 11,
    message: {
      message_id: 558,
      date: 1700000300,
      chat: { id: -1001111111111, type: 'supergroup' },
      from: { id: 1000, is_bot: false, first_name: 'Boris' },
      text: 'replying to Anna, not to the post',
      reply_to_message: {
        message_id: 556, // Anna's comment, not the post itself
        message_thread_id: 555, // the thread root the whole conversation belongs to
      },
    },
  })
  assert.equal(decision.kind, 'comment')
  if (decision.kind === 'comment') {
    assert.equal(decision.threadId, '555', 'nested replies must resolve to the SAME thread root as the rest of the conversation')
    assert.equal(decision.externalCommentId, '558')
  }
})

test('message_thread_id on the message itself always takes priority over reply_to_message (the normal, most common case)', () => {
  const decision = classifyTelegramCommentsUpdate({
    message: {
      message_id: 559,
      date: 1700000400,
      chat: { id: -1001111111111, type: 'supergroup' },
      message_thread_id: 555,
      reply_to_message: { message_id: 556, message_thread_id: 999 }, // deliberately different/wrong, must be ignored
      text: 'normal reply',
    },
  })
  assert.equal(decision.kind, 'comment')
  if (decision.kind === 'comment') assert.equal(decision.threadId, '555')
})

test('a reply to a message that is neither the auto-forward nor itself threaded has no way to resolve a thread — ignored, not guessed', () => {
  const decision = classifyTelegramCommentsUpdate({
    message: {
      message_id: 560,
      date: 1700000500,
      chat: { id: -1001111111111, type: 'supergroup' },
      text: 'replying to an ordinary, unthreaded group message',
      reply_to_message: { message_id: 10, text: 'just a regular group message, not a post or a comment' },
    },
  })
  assert.equal(decision.kind, 'ignore')
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
