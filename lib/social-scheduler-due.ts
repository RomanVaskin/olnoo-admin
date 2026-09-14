// Pure, dependency-free date logic for the Social scheduler, kept separate from
// lib/social-scheduler.ts (which needs the "@/..." alias for lib/db and the fan-out publisher)
// so it's directly unit-testable with the project's plain node:test runner.
//
// social_posts.publish_date is (and stays) a plain TEXT column — no migration was needed to
// support date+time. The post edit UI now writes an HTML <input type="datetime-local"> value
// ("YYYY-MM-DDTHH:mm", no timezone offset), while older rows may still hold a plain
// <input type="date"> value ("YYYY-MM-DD") from before this change. Both parse fine with the
// native Date constructor, though per the ECMA-262 Date Time String Format they're interpreted
// differently: a date-only string is parsed as UTC midnight, a date-time string with no offset is
// parsed as local time in whatever timezone this Node process runs (the KZ production server's
// timezone). That's an intentional, documented simplification for a single-server MVP — bringing
// in a timezone library to normalize the two would be new complexity this task doesn't need.

/** Parses social_posts.publish_date into a Date, or null if it's empty/unparseable. */
export function parsePublishDate(value: string): Date | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Whether a stored publish_date has arrived (is now in the past or present) relative to `now`
 * (defaults to the real current time — overridable for tests). An empty or unparseable
 * publish_date is never "due": a Ready post with no schedule set stays manual, exactly as it
 * behaved before the scheduler existed. */
export function isPublishDue(value: string, now: Date = new Date()): boolean {
  const date = parsePublishDate(value)
  if (!date) return false
  return date.getTime() <= now.getTime()
}
