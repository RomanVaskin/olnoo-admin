import test from 'node:test'
import assert from 'node:assert/strict'
import { telegramPublicationOutcome } from './content-factory-publish-outcome.ts'

test('Telegram success requires a published publication row', () => {
  assert.deepEqual(telegramPublicationOutcome({ row: { status: 'published' } }), { published: true })
})

test('a failed Telegram publication row retains its error', () => {
  assert.deepEqual(telegramPublicationOutcome({ row: { status: 'failed', error: 'Forbidden: bot cannot post' } }), {
    published: false,
    error: 'Forbidden: bot cannot post',
    status: 502,
  })
})

test('an unknown send outcome stays an error and is not treated as delivered', () => {
  assert.deepEqual(telegramPublicationOutcome({ error: 'Could not confirm whether Telegram received the message', status: 503 }), {
    published: false,
    error: 'Could not confirm whether Telegram received the message',
    status: 503,
  })
})
