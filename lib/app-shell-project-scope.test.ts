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
// (components/app-shell.tsx): the project a write (create/edit/publish) happens under must come
// only from a real, explicit ?project= in the URL (from a bookmark/link or from clicking
// ProjectSelector) — never guessed. social-posts/social-accounts themselves no longer require this
// upfront just to LIST data — like social-overview, they now support "All projects" with a
// cross-project read (see lib/social-project-selector-wiring.test.ts) — but still never
// auto-select a project for a write, which is enforced inside each screen's own CreateForm/
// PostDetail/AccountDetail, not by gating the whole screen here.

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

test('app-shell: ads still only renders its real content once a real project slug is in the URL, with no fallback path', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  // 'ads' is the one screen this task leaves untouched — it still cannot handle "all" at all, so
  // it keeps the simple short-circuit form rather than gaining an "All projects" view.
  assert.match(source, /active === 'ads' && project !== 'all' && <AdsView/, "ads must stay gated on an explicit, non-'all' project")
  // `project` itself must be derived directly from the URL's own ?project= param, not from any
  // effect that could overwrite it with a remembered value before these screens render.
  const rawProjectIdx = source.indexOf("searchParams.get('project')")
  assert.ok(rawProjectIdx > 0, 'project must be read directly from the URL search params')
})

test('app-shell: social-posts and social-accounts render unconditionally (support both "all" and one project), same as social-overview', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  for (const [screen, component] of [
    ['social-overview', 'SocialOverview'],
    ['social-posts', 'SocialView'],
    ['social-accounts', 'SocialAccountsView'],
  ] as const) {
    const idx = source.indexOf(`active === '${screen}'`)
    assert.ok(idx > 0, `${screen} must be handled`)
    const nextIdx = source.indexOf("{active ===", idx + 1)
    const block = source.slice(idx, nextIdx > 0 ? nextIdx : idx + 200)
    assert.match(block, new RegExp(`<${component} project=\\{project\\} onProjectChange=\\{setProject\\}`))
    assert.ok(
      !block.includes("project !== 'all'"),
      `${screen} must not be gated on project !== 'all' — it supports the "All projects" aggregate view`,
    )
  }
})

test('app-shell: the removed SelectProjectPrompt (and its project-picker gate) is gone for good', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  assert.ok(
    !source.includes('SelectProjectPrompt'),
    'social-posts/social-accounts list unconditionally now (like social-overview) — the blocking ' +
      '"select a project" screen that used to stand in for them when project === \'all\' must not ' +
      'reappear; the per-project requirement moved into each screen\'s own write paths instead',
  )
})

test("app-shell: 'social-overview' is the first child of the Social nav group", async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  const socialGroupIdx = source.indexOf("id: 'social',")
  assert.ok(socialGroupIdx > 0)
  const childrenIdx = source.indexOf('children:', socialGroupIdx)
  const childrenLine = source.slice(childrenIdx, source.indexOf(']', childrenIdx) + 1)
  assert.match(childrenLine, /\[\s*\{ id: 'social-overview' \}/, "social-overview must be the first entry so it's the Social group's default screen")
})
