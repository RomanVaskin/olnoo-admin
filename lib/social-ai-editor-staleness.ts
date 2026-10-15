// AI Editor staleness guard — pure, dependency-free (same convention as
// lib/social-scheduler-due.ts/lib/social-publish-date-format.ts: logic a UI component needs to get
// right, extracted so it is directly testable under `node --test` even though this repo has no
// React/DOM component-test setup). Used by components/sections/social-view.tsx's PostDetail to
// decide whether an AI Editor response that just arrived may still be shown/applied, or must be
// discarded because the user edited Content or switched to a different post while the request
// was in flight.

export type EditorRequestSnapshot = { postId: string; text: string }

/**
 * True when `current` (the live post id + Content text at the moment the AI Editor's response
 * arrives) still matches `requested` (the snapshot taken at the moment the request was fired).
 * False means the request is stale — its result must be discarded silently, never shown as a
 * proposal and never applied, because it was computed from text that is no longer on screen (the
 * user edited Content) or for a post that is no longer open (the user switched posts).
 */
export function isEditorResultStillValid(requested: EditorRequestSnapshot, current: EditorRequestSnapshot): boolean {
  return requested.postId === current.postId && requested.text === current.text
}
