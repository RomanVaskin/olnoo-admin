import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeAccountStatusCounts } from './social-overview-metrics.ts'

test('summarizeAccountStatusCounts: sums each known status into its own bucket, plus a total', () => {
  const result = summarizeAccountStatusCounts([
    { status: 'connected', count: 3 },
    { status: 'error', count: 1 },
    { status: 'created', count: 2 },
  ])
  assert.deepEqual(result, { total: 6, connected: 3, error: 1, created: 2 })
})

test('summarizeAccountStatusCounts: no rows -> every count is 0, never undefined/NaN', () => {
  assert.deepEqual(summarizeAccountStatusCounts([]), { total: 0, connected: 0, error: 0, created: 0 })
})

test('summarizeAccountStatusCounts: an unrecognized status still counts toward total, never dropped', () => {
  const result = summarizeAccountStatusCounts([{ status: 'something_new', count: 5 }])
  assert.equal(result.total, 5)
  assert.equal(result.connected, 0)
  assert.equal(result.error, 0)
  assert.equal(result.created, 0)
})

test('summarizeAccountStatusCounts: connected and error counts are never combined into one number', () => {
  const result = summarizeAccountStatusCounts([
    { status: 'connected', count: 10 },
    { status: 'error', count: 10 },
  ])
  assert.notEqual(result.connected, result.error + result.connected)
  assert.equal(result.connected, 10)
  assert.equal(result.error, 10)
})
