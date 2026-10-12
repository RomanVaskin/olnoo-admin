import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — components/app-shell.tsx is a React client component
// using Next.js navigation hooks, which this project's plain `node --test` runner has no DOM/React
// harness to execute (this repo's test convention only covers lib/*.ts pure logic; see the other
// *-wiring.test.ts files for the same reasoning applied to files that use `@/`-aliased imports).
//
// Root cause this guards against regressing: social-posts/social-accounts/ads (the only screens
// that create or publish data under "the current project") used to silently fall back to a project
// slug remembered in localStorage from a PREVIOUS, unrelated browsing session whenever the URL had
// no explicit ?project=. That is exactly how a new Instagram account, or a new post, ended up
// attached to the wrong client's project with no visible action by the admin — confirmed as the
// cause of a production Instagram account and its publications being recorded under project
// "domtrack" while the admin believed they were working on OLNOO's own project. Removed entirely
// (components/app-shell.tsx): these screens now render nothing until a real, explicit ?project= is
// present in the URL (from a bookmark/link or from clicking ProjectSelector) — never guessed.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('app-shell: no localStorage-based fallback can silently choose which project a write-capable screen operates under', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  assert.ok(
    !/localStorage\.(get|set)Item/.test(source),
    'app-shell.tsx must not read or write any remembered project slug via localStorage (mentioning ' +
      'it in a comment, e.g. explaining why it was removed, is fine) — the project a social-' +
      'accounts/social-posts/ads screen operates under must come only from the current URL or an ' +
      'explicit ProjectSelector click',
  )
})

test('app-shell: social-posts, social-accounts and ads only render their real content once a real project slug is in the URL, with no fallback path', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  // 'ads' is untouched by this change — still the simple short-circuit form.
  assert.match(source, /active === 'ads' && project !== 'all' && <AdsView/, "ads must stay gated on an explicit, non-'all' project")
  // social-posts/social-accounts now show an explicit project-picker prompt (SelectProjectPrompt)
  // instead of rendering nothing when project === 'all' — but the real, data-fetching/write-
  // capable component (SocialView/SocialAccountsView) must still only ever appear in the
  // project !== 'all' branch, never as a fallback for 'all'.
  for (const [screen, component] of [
    ['social-posts', 'SocialView'],
    ['social-accounts', 'SocialAccountsView'],
  ] as const) {
    const screenIdx = source.indexOf(`active === '${screen}'`)
    assert.ok(screenIdx > 0, `${screen} must still be handled`)
    const block = source.slice(screenIdx, screenIdx + 400)
    assert.match(block, /project !== 'all'/, `${screen} must still branch on an explicit, non-'all' project`)
    const ternaryIdx = block.search(/\?\s*\n?\s*<\w/)
    assert.ok(ternaryIdx > 0, `${screen} must use a ternary (real screen vs. project-picker prompt)`)
    const trueBranch = block.slice(0, block.indexOf(':', ternaryIdx))
    assert.ok(trueBranch.includes(component), `${screen}'s project !== 'all' branch must render ${component}`)
    assert.ok(!trueBranch.includes('SelectProjectPrompt'), `${screen} must not render the picker prompt in its real-project branch`)
  }
  // `project` itself must be derived directly from the URL's own ?project= param, not from any
  // effect that could overwrite it with a remembered value before these screens render.
  const rawProjectIdx = source.indexOf("searchParams.get('project')")
  assert.ok(rawProjectIdx > 0, 'project must be read directly from the URL search params')
})

test('app-shell: social-overview renders unconditionally (supports both "all" and one project), unlike Posts/Accounts', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  const idx = source.indexOf("active === 'social-overview'")
  assert.ok(idx > 0, 'social-overview must be handled')
  const block = source.slice(idx, idx + 150)
  assert.match(block, /<SocialOverview project=\{project\} onProjectChange=\{setProject\}/)
  assert.ok(!block.includes("project !== 'all'"), "social-overview must not be gated on project !== 'all' — it supports the aggregate view")
})

test("app-shell: 'social-overview' is the first child of the Social nav group", async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  const socialGroupIdx = source.indexOf("id: 'social',")
  assert.ok(socialGroupIdx > 0)
  const childrenIdx = source.indexOf('children:', socialGroupIdx)
  const childrenLine = source.slice(childrenIdx, source.indexOf(']', childrenIdx) + 1)
  assert.match(childrenLine, /\[\s*\{ id: 'social-overview' \}/, "social-overview must be the first entry so it's the Social group's default screen")
})

test('app-shell: SelectProjectPrompt reuses the shared ProjectSelector, not a new/ad-hoc picker', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  const fnIdx = source.indexOf('function SelectProjectPrompt')
  assert.ok(fnIdx > 0, 'SelectProjectPrompt must exist')
  const fnBody = source.slice(fnIdx, fnIdx + 600)
  assert.match(fnBody, /<ProjectSelector\b/, 'must render the existing ProjectSelector component')
  assert.match(source, /import \{ ProjectSelector \} from '@\/components\/project-selector'/)
})
