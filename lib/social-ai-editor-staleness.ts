// AI Editor staleness guard — pure, dependency-free (same convention as
// lib/social-scheduler-due.ts/lib/social-publish-date-format.ts: logic a UI component needs to get
// right, extracted so it is directly testable under `node --test` even though this repo has no
// React/DOM component-test setup). Used by components/sections/social-view.tsx's PostDetail at TWO
// points, both comparing the same kind of snapshot: (1) when an AI Editor response arrives, to
// decide whether it may still be shown as a proposal, or must be discarded because the user edited
// Content or switched to a different post while the request was in flight; (2) when the user clicks
// "Apply" on an already-shown proposal, to refuse applying it if Content or the open post changed
// in the (arbitrarily long, expected) time between the proposal arriving and Apply being clicked —
// otherwise Apply would silently overwrite whatever new edit the user made in the meantime.

export type EditorRequestSnapshot = { postId: string; text: string }

/**
 * True when `current` (the live post id + Content text, read at the moment this check runs) still
 * matches `requested` (the snapshot taken when the AI Editor request that produced this result was
 * fired). False means the result is stale — it must be discarded/refused, never shown as a
 * proposal and never applied, because it was computed from text that is no longer on screen (the
 * user edited Content) or for a post that is no longer open (the user switched posts).
 */
export function isEditorResultStillValid(requested: EditorRequestSnapshot, current: EditorRequestSnapshot): boolean {
  return requested.postId === current.postId && requested.text === current.text
}
