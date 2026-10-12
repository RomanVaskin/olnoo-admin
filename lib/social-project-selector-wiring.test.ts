import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — components/sections/social-view.tsx and
// social-accounts-view.tsx are React client components; this repo's `node --test` convention only
// covers lib/*.ts pure logic (see lib/app-shell-project-scope.test.ts for the same reasoning).
//
// What this guards: Social → Posts/Accounts previously had no visible way to choose a project at
// all (unlike CRM/Admin Overview, which always rendered ProjectSelector) — the only way to get a
// different project onto these screens was to edit the URL by hand, or to have arrived there with
// one already carried over from another screen. Combined with the now-removed localStorage
// fallback, this is how a post/account could get created under project "domtrack" with no direct
// way for the admin to notice or fix it from the Social screens themselves. Both screens now
// render the existing ProjectSelector directly, and every create/publish request still sends
// exactly the `project` prop they were given — never a different, substituted value.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('social-view.tsx (Posts): reuses the existing ProjectSelector and forwards it as onProjectChange', async () => {
  const source = await sourceOf('../components/sections/social-view.tsx')
  assert.match(source, /import \{ ProjectSelector \} from '@\/components\/project-selector'/)
  assert.match(source, /<ProjectSelector value=\{project\} onChange=\{onProjectChange\}/)
  assert.match(source, /onProjectChange:\s*\(id:\s*string\)\s*=>\s*void/, 'SocialView must accept onProjectChange')
})

test('social-accounts-view.tsx (Accounts): reuses the existing ProjectSelector and forwards it as onProjectChange', async () => {
  const source = await sourceOf('../components/sections/social-accounts-view.tsx')
  assert.match(source, /import \{ ProjectSelector \} from '@\/components\/project-selector'/)
  assert.match(source, /<ProjectSelector value=\{project\} onChange=\{onProjectChange\}/)
  assert.match(source, /onProjectChange:\s*\(id:\s*string\)\s*=>\s*void/, 'SocialAccountsView must accept onProjectChange')
})

test('social-view.tsx: creating a post always sends the exact `project` the screen was given, never a hardcoded or substituted value', async () => {
  const source = await sourceOf('../components/sections/social-view.tsx')
  // The CreateForm's submit body must reference `project` (the prop) directly.
  const submitIdx = source.indexOf('async function submit()')
  assert.ok(submitIdx > 0)
  const submitBody = source.slice(submitIdx, submitIdx + 600)
  assert.match(submitBody, /JSON\.stringify\(\{\s*project,\s*topic\s*\}\)/, 'post creation must send the project prop as-is')
})

test('social-accounts-view.tsx: creating an account always sends the exact `project` the screen was given, never a hardcoded or substituted value', async () => {
  const source = await sourceOf('../components/sections/social-accounts-view.tsx')
  const submitIdx = source.indexOf('async function submit()')
  assert.ok(submitIdx > 0)
  const submitBody = source.slice(submitIdx, submitIdx + 600)
  assert.match(submitBody, /JSON\.stringify\(\{\s*project,\s*platform,\s*name,\s*username\s*\}\)/, 'account creation must send the project prop as-is')
})

test('app-shell.tsx: passes onProjectChange (setProject) into both Social screens, not just project', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  assert.match(source, /<SocialView project=\{project\} onProjectChange=\{setProject\}/)
  assert.match(source, /<SocialAccountsView project=\{project\} onProjectChange=\{setProject\}/)
})

// Requirement: ProjectSelector must sit in the same place (SectionHeader's `action`, top-right)
// on Overview, Posts and Accounts — same as CrmOverview/AdminOverview — not in the filter row
// below, so the current project is equally visible and equally reachable on all three screens.
test('social-view.tsx and social-accounts-view.tsx: ProjectSelector lives in SectionHeader.action, not the filter row', async () => {
  for (const file of ['../components/sections/social-view.tsx', '../components/sections/social-accounts-view.tsx']) {
    const source = await sourceOf(file)
    const sectionHeaderIdx = source.indexOf('<SectionHeader')
    assert.ok(sectionHeaderIdx > 0, `${file}: must render SectionHeader`)
    const actionIdx = source.indexOf('action={', sectionHeaderIdx)
    assert.ok(actionIdx > sectionHeaderIdx, `${file}: SectionHeader must have an action prop`)
    assert.match(source.slice(actionIdx, actionIdx + 250), /<ProjectSelector/, `${file}: ProjectSelector must be inside SectionHeader's action`)

    // The filter-bar className is reused by both the new action wrapper and the real filter row
    // below it — take the LAST occurrence (the actual filter row, after the metrics section) and
    // confirm ProjectSelector is not there; the old placement had it as that row's first child.
    const filterBarIdx = source.lastIndexOf("flex flex-wrap items-center gap-2")
    assert.ok(filterBarIdx > actionIdx, `${file}: the real filter bar must come after the header's action`)
    const filterBarSnippet = source.slice(filterBarIdx, filterBarIdx + 150)
    assert.ok(!filterBarSnippet.includes('<ProjectSelector'), `${file}: ProjectSelector must not also sit in the filter row`)
  }
})

test('social-overview.tsx: ProjectSelector lives in SectionHeader.action, same as CrmOverview', async () => {
  const source = await sourceOf('../components/sections/social-overview.tsx')
  assert.match(source, /action=\{<ProjectSelector value=\{project\} onChange=\{onProjectChange\} \/>\}/)
})
