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

// --- The same function, used at a second call site: PostDetail's applyEditorProposal, run at the
// moment the user clicks "Apply" on an already-shown proposal — a window that can be arbitrarily
// long (reading a proposal takes time), unlike the in-flight race the tests above cover. ---

test('requirement: Apply is allowed when Content was NOT edited and the post was NOT switched since the proposal arrived', () => {
  const proposalSnapshot = { postId: 'post-1', text: 'Original content' }
  const atApplyClick = { postId: 'post-1', text: 'Original content' }
  assert.equal(isEditorResultStillValid(proposalSnapshot, atApplyClick), true)
})

test('requirement: Apply is refused when the user edited Content after receiving the proposal but before clicking Apply', () => {
  const proposalSnapshot = { postId: 'post-1', text: 'Original content' }
  const atApplyClick = { postId: 'post-1', text: 'Original content, edited by the user while the proposal sat on screen' }
  assert.equal(isEditorResultStillValid(proposalSnapshot, atApplyClick), false)
})

test('requirement: Apply is refused when the user switched to a different post after receiving the proposal but before clicking Apply', () => {
  const proposalSnapshot = { postId: 'post-1', text: 'Original content' }
  const atApplyClick = { postId: 'post-2', text: 'Original content' }
  assert.equal(isEditorResultStillValid(proposalSnapshot, atApplyClick), false)
})

test('requirement: Apply is refused when the user switched posts AND the new post\'s Content happens to differ too', () => {
  const proposalSnapshot = { postId: 'post-1', text: 'Original content' }
  const atApplyClick = { postId: 'post-2', text: 'A totally different post\'s own content' }
  assert.equal(isEditorResultStillValid(proposalSnapshot, atApplyClick), false)
})
