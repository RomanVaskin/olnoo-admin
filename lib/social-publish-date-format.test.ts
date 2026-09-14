import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toDatetimeLocalInputValue, formatPublishDate } from './social-publish-date-format.ts'

test('toDatetimeLocalInputValue passes a well-formed datetime-local value through', () => {
  assert.equal(toDatetimeLocalInputValue('2026-09-20T14:30'), '2026-09-20T14:30')
})

test('toDatetimeLocalInputValue trims seconds if present', () => {
  assert.equal(toDatetimeLocalInputValue('2026-09-20T14:30:00'), '2026-09-20T14:30')
})

test('toDatetimeLocalInputValue upgrades a legacy date-only value to midnight', () => {
  assert.equal(toDatetimeLocalInputValue('2026-09-20'), '2026-09-20T00:00')
})

test('toDatetimeLocalInputValue returns empty for an empty or unparseable value', () => {
  assert.equal(toDatetimeLocalInputValue(''), '')
  assert.equal(toDatetimeLocalInputValue('   '), '')
  assert.equal(toDatetimeLocalInputValue('not-a-date'), '')
})

test('formatPublishDate shows date and time for a datetime-local value', () => {
  assert.equal(formatPublishDate('2026-09-20T14:30'), '20 Sept 2026, 14:30')
})

test('formatPublishDate shows only the date for a legacy date-only value', () => {
  assert.equal(formatPublishDate('2026-09-20'), '20 Sept 2026')
})

test('formatPublishDate returns an em dash for empty/unparseable values', () => {
  assert.equal(formatPublishDate(''), '—')
  assert.equal(formatPublishDate('not-a-date'), '—')
})
