import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPublishDue, parsePublishDate } from './social-scheduler-due.ts'

const NOW = new Date('2026-09-14T12:00:00Z')

test('an empty publish_date is never due', () => {
  assert.equal(isPublishDue('', NOW), false)
  assert.equal(isPublishDue('   ', NOW), false)
})

test('an unparseable publish_date is never due', () => {
  assert.equal(isPublishDue('not-a-date', NOW), false)
  assert.equal(parsePublishDate('not-a-date'), null)
})

test('a future datetime-local publish_date is not due', () => {
  assert.equal(isPublishDue('2026-09-14T20:00', new Date('2026-09-14T12:00:00Z')), false)
})

test('a past datetime-local publish_date is due', () => {
  assert.equal(isPublishDue('2026-09-14T05:00', new Date('2026-09-14T12:00:00Z')), true)
})

test('a publish_date exactly at "now" is due (inclusive boundary)', () => {
  const now = new Date('2026-09-14T12:00:00.000Z')
  assert.equal(isPublishDue(now.toISOString(), now), true)
})

test('a legacy date-only publish_date in the past is due', () => {
  assert.equal(isPublishDue('2020-01-01', NOW), true)
})

test('a legacy date-only publish_date far in the future is not due', () => {
  assert.equal(isPublishDue('2099-01-01', NOW), false)
})
