// Pure, dependency-free formatting helpers for social_posts.publish_date — kept out of
// components/sections/social-view.tsx (a 'use client' component with JSX, which the project's
// plain node:test runner can't import) so both the post editor's <input type="datetime-local"> and
// the Posts list column can share one implementation, and so it's directly unit-testable.
//
// publish_date is (and stays) a plain TEXT column: no migration was needed to move from
// date-only to date+time — see lib/social-scheduler-due.ts for why, and for how the scheduler
// itself interprets these same strings.

/** Normalizes a stored publish_date into the exact format <input type="datetime-local"> requires
 * ("YYYY-MM-DDTHH:mm"). A well-formed datetime-local value passes through unchanged; a legacy
 * date-only value ("YYYY-MM-DD", from before this field supported time) is upgraded to midnight so
 * older posts remain editable in the new control; anything empty or unrecognized becomes '' so the
 * control just renders blank instead of silently failing on a malformed value. */
export function toDatetimeLocalInputValue(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return trimmed.slice(0, 16)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00`
  return ''
}

/** Human-readable local date (plus time, when the stored value actually carries one) for display
 * — e.g. the Posts list column. Returns '—' for an empty or unparseable value. */
export function formatPublishDate(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '—'
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return '—'
  const hasTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)
  return hasTime
    ? date.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
