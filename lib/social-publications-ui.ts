// Tiny, JSX-free piece of the Publications UI's button logic, pulled out purely so it's testable
// with the project's plain-.ts node:test runner (components/*.tsx can't be imported there — JSX
// isn't valid input for --experimental-strip-types, which only strips types, not syntax).

/** Same rule the Telegram/VK/Instagram branches already use inline in social-publications.tsx:
 * the automated "Publish to <platform>" button only replaces the manual "Mark as published"
 * button for an unpublished Threads publication. */
export function shouldShowThreadsPublishButton(platform: string, status: string): boolean {
  return platform === 'threads' && status !== 'published'
}
