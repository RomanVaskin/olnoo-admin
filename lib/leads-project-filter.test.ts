import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLeadsProjectFilter, wantsAllProjects } from './leads-project-filter.ts'

test('no project param -> wants all projects', () => {
  assert.equal(wantsAllProjects(null), true)
  assert.deepEqual(resolveLeadsProjectFilter(null, null), { kind: 'all' })
})

test('project=all -> wants all projects', () => {
  assert.equal(wantsAllProjects('all'), true)
  assert.deepEqual(resolveLeadsProjectFilter('all', null), { kind: 'all' })
})

test('a slug that resolves to a real project id -> scoped to that one project', () => {
  assert.equal(wantsAllProjects('driveset'), false)
  assert.deepEqual(resolveLeadsProjectFilter('driveset', 7), { kind: 'one', projectId: 7 })
})

// Regression for the fail-open bug: an unknown/typo'd slug must return no leads, never fall
// back to "all" and leak every other project's leads.
test('an unknown project slug -> no leads, never falls back to "all"', () => {
  assert.equal(wantsAllProjects('not-a-real-project'), false)
  assert.deepEqual(resolveLeadsProjectFilter('not-a-real-project', null), { kind: 'none' })
  assert.notDeepEqual(resolveLeadsProjectFilter('not-a-real-project', null), { kind: 'all' })
})

test('an empty-string project param is treated as "all", same as missing', () => {
  assert.equal(wantsAllProjects(''), true)
  assert.deepEqual(resolveLeadsProjectFilter('', null), { kind: 'all' })
})
