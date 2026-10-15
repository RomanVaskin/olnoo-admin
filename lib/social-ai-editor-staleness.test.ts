import test from 'node:test'
import assert from 'node:assert/strict'
import { isEditorResultStillValid } from './social-ai-editor-staleness.ts'

test('isEditorResultStillValid: true when post and text are unchanged since the request was fired', () => {
  const requested = { postId: 'post-1', text: 'Original content' }
  const current = { postId: 'post-1', text: 'Original content' }
  assert.equal(isEditorResultStillValid(requested, current), true)
})

test('requirement: false when the user edited Content while the AI request was in flight', () => {
  const requested = { postId: 'post-1', text: 'Original content' }
  const current = { postId: 'post-1', text: 'Original content, but the user typed more' }
  assert.equal(isEditorResultStillValid(requested, current), false)
})

test('requirement: false when the user switched to a different post while the AI request was in flight', () => {
  const requested = { postId: 'post-1', text: 'Original content' }
  const current = { postId: 'post-2', text: 'Original content' }
  assert.equal(isEditorResultStillValid(requested, current), false)
})

test('requirement: false when the user both switched posts AND the new post happens to start with different text', () => {
  const requested = { postId: 'post-1', text: 'Original content' }
  const current = { postId: 'post-2', text: 'Completely different text' }
  assert.equal(isEditorResultStillValid(requested, current), false)
})

test('edge case: switching away and back to the SAME post with the SAME text is still valid', () => {
  const requested = { postId: 'post-1', text: 'Original content' }
  const current = { postId: 'post-1', text: 'Original content' }
  assert.equal(isEditorResultStillValid(requested, current), true)
})
