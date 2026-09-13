import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveThreadsText } from './social-threads-text.ts'

test('resolveThreadsText prefers threads_text over the shared body when both are set', () => {
  assert.equal(resolveThreadsText('Threads-only text', 'Shared body'), 'Threads-only text')
})

test('resolveThreadsText falls back to the shared body when threads_text is empty', () => {
  assert.equal(resolveThreadsText('', 'Shared body'), 'Shared body')
  assert.equal(resolveThreadsText(null, 'Shared body'), 'Shared body')
  assert.equal(resolveThreadsText(undefined, 'Shared body'), 'Shared body')
})

test('resolveThreadsText falls back to the shared body when threads_text is only whitespace', () => {
  assert.equal(resolveThreadsText('   ', 'Shared body'), 'Shared body')
})

test('resolveThreadsText trims both fields', () => {
  assert.equal(resolveThreadsText('  padded threads text  ', 'Shared body'), 'padded threads text')
  assert.equal(resolveThreadsText('', '  padded body  '), 'padded body')
})

test('resolveThreadsText returns an empty string when there is no content anywhere', () => {
  assert.equal(resolveThreadsText('', ''), '')
  assert.equal(resolveThreadsText(null, null), '')
})
