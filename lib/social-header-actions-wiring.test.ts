import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — components/primitives.tsx and the two social section
// files are React client components; this repo's `node --test` convention only covers lib/*.ts
// pure logic (see lib/app-shell-project-scope.test.ts for the same reasoning).
//
// Root cause this guards against regressing: ProjectSelector renders two stacked lines (name +
// domain) inside its own button, so next to a single-line "+ Add" button with the same padding it
// was always taller — with `items-center` on their shared row, the shorter button just sat
// vertically centered at its own natural (shorter) height, visibly misaligned against the taller
// selector. Fixed with ONE shared primitive (`HeaderActions`, `items-stretch`) used identically by
// both Posts and Accounts, rather than two independent per-screen height hacks; the single-line
// button additionally needs `items-center justify-center` on itself so its label re-centers once
// stretched to match.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('primitives.tsx: HeaderActions exists and stretches its children to equal height', async () => {
  const source = await sourceOf('../components/primitives.tsx')
  const idx = source.indexOf('export function HeaderActions')
  assert.ok(idx > 0, 'HeaderActions must be exported from the shared primitives module')
  assert.match(source.slice(idx, idx + 200), /items-stretch/, 'HeaderActions must stretch its children to the same height, not just center them')
})

test('social-view.tsx and social-accounts-view.tsx both use the SAME shared HeaderActions primitive, not independent per-screen wrappers', async () => {
  for (const file of ['../components/sections/social-view.tsx', '../components/sections/social-accounts-view.tsx']) {
    const source = await sourceOf(file)
    assert.match(source, /import \{ SectionHeader, HeaderActions,/, `${file}: must import the shared HeaderActions primitive`)
    assert.match(source, /<HeaderActions>/, `${file}: SectionHeader's action must use HeaderActions`)
    assert.match(source, /<\/HeaderActions>/)
    // The old, independently-styled per-screen wrapper div must not reappear.
    assert.ok(!/action=\{\s*<div className="flex flex-wrap items-center gap-2">/.test(source), `${file}: must not reintroduce a bespoke action-row wrapper`)
  }
})

test("social-view.tsx and social-accounts-view.tsx: the single-line action button re-centers its label once stretched", async () => {
  for (const file of ['../components/sections/social-view.tsx', '../components/sections/social-accounts-view.tsx']) {
    const source = await sourceOf(file)
    const headerActionsIdx = source.indexOf('<HeaderActions>')
    assert.ok(headerActionsIdx > 0)
    const block = source.slice(headerActionsIdx, source.indexOf('</HeaderActions>', headerActionsIdx))
    assert.match(block, /className="label-mono flex items-center justify-center border border-foreground/, `${file}: the add button must center its label when stretched to match ProjectSelector's height`)
  }
})
