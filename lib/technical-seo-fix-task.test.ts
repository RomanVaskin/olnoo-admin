import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildTechnicalSeoFixTask, dedupeIssues, type FixTaskProject } from './technical-seo-fix-task.ts'
import type { Issue, PageCheck } from './seo-health.ts'

const page = (path: string, over: Partial<PageCheck> = {}): PageCheck => ({
  url: `https://driveset.ru${path}`, httpStatus: 200, canonical: `https://driveset.ru${path}`, indexing: 'index', title: `T ${path}`, h1: `H ${path}`, redirectTo: null, inSitemap: true, ...over,
})
const DRIVESET: FixTaskProject = {
  projectName: 'DriveSet',
  domain: 'https://driveset.ru',
  sitemapUrl: 'https://driveset.ru/sitemap.xml',
  robots: { status: 'Missing', httpStatus: 404, disallowAll: false },
  sitemap: { status: 'OK', httpStatus: 200, urlCount: 4 },
  pages: [page('/'), page('/okleyka-avto'), page('/polirovka-avto'), page('/himchistka-avto')],
}
const ROBOTS: Issue = { severity: 'WARNING', code: 'robots_missing', message: 'robots.txt is missing' }
const pageIssue = (path: string, code: string, severity: Issue['severity'] = 'WARNING'): Issue => ({ severity, code, url: `https://driveset.ru${path}`, message: `${code} message` })

test('single issue: the prompt contains only that problem and its rule', () => {
  const task = buildTechnicalSeoFixTask(DRIVESET, [ROBOTS])!
  assert.match(task, /ISSUES \(1\)/)
  assert.match(task, /1\. \[WARNING\] robots_missing — robots\.txt is missing/)
  assert.match(task, /app\/robots\.ts/)
  assert.doesNotMatch(task, /canonical_missing|noindex_in_sitemap|sitemap_missing:/)
})

test('DriveSet robots_missing task: project facts, robots 404, sitemap URL, 4 URLs, git workflow without merge', () => {
  const task = buildTechnicalSeoFixTask(DRIVESET, [ROBOTS])!
  for (const s of ['Название: DriveSet', 'Domain: https://driveset.ru', 'Sitemap URL: https://driveset.ru/sitemap.xml', 'robots.txt: HTTP 404', 'URL в sitemap: 4', 'BUSINESS FACTS RULE', 'НЕ делай merge', 'отдельную ветку', 'root causes', 'intentionally not fixed']) {
    assert.ok(task.includes(s), s)
  }
  assert.match(task, /ссылку на существующий sitemap/)
  assert.match(task, /Публичный сайт не закрывай/)
})

test('Fix all: ONE prompt with every ERROR and WARNING of the project, ERRORs first', () => {
  const issues = [ROBOTS, pageIssue('/a', 'canonical_missing'), pageIssue('/b', 'noindex_in_sitemap', 'ERROR'), { severity: 'ERROR', code: 'sitemap_missing', message: 'Sitemap is missing' } as Issue]
  const task = buildTechnicalSeoFixTask(DRIVESET, issues)!
  assert.match(task, /ISSUES \(4\)/)
  assert.equal([...task.matchAll(/^TECHNICAL SEO FIX TASK/gm)].length, 1)
  const order = [...task.matchAll(/^\d+\. \[(ERROR|WARNING)\] (\w+)/gm)].map((m) => `${m[1]}:${m[2]}`)
  assert.deepEqual(order, ['ERROR:noindex_in_sitemap', 'ERROR:sitemap_missing', 'WARNING:canonical_missing', 'WARNING:robots_missing'])
  for (const code of ['noindex_in_sitemap', 'sitemap_missing', 'canonical_missing', 'robots_missing']) assert.ok(task.includes(`- ${code}:`), `rule ${code}`)
  assert.match(task, /Не снимай noindex автоматически/)
  assert.match(task, /app\/sitemap\.ts/)
})

test('no duplicates: the same issue (severity + code + URL) is listed once; different URLs are kept', () => {
  const dup = [ROBOTS, { ...ROBOTS }, pageIssue('/a', 'h1_missing'), pageIssue('/a', 'h1_missing'), pageIssue('/b', 'h1_missing')]
  assert.equal(dedupeIssues(dup).length, 3)
  const task = buildTechnicalSeoFixTask(DRIVESET, dup)!
  assert.match(task, /ISSUES \(3\)/)
  assert.equal([...task.matchAll(/robots_missing —/g)].length, 1)
  assert.equal([...task.matchAll(/URL: https:\/\/driveset\.ru\/a$/gm)].length, 1)
})

test('factual values of the problem URL are included (HTTP, canonical, index, Title, H1, redirect)', () => {
  const project: FixTaskProject = {
    ...DRIVESET,
    pages: [
      page('/x', { httpStatus: 301, redirectTo: 'https://driveset.ru/y', title: null, h1: null, canonical: null, indexing: 'noindex' }),
      page('/z', { title: 'Моя страница', h1: 'Заголовок', canonical: 'https://driveset.ru/other' }),
    ],
  }
  const task = buildTechnicalSeoFixTask(project, [pageIssue('/x', 'page_redirect'), pageIssue('/z', 'canonical_mismatch')])!
  assert.match(task, /URL: https:\/\/driveset\.ru\/x\n   Факты: HTTP 301 · canonical: нет · индексация: noindex · Title: нет · H1: нет · redirect → https:\/\/driveset\.ru\/y/)
  assert.match(task, /URL: https:\/\/driveset\.ru\/z\n   Факты: HTTP 200 · canonical: https:\/\/driveset\.ru\/other · индексация: index · Title: Моя страница · H1: Заголовок/)
})

test('only the given issues and this project’s own pages appear — nothing from other projects', () => {
  const other: FixTaskProject = { ...DRIVESET, projectName: 'Other', domain: 'https://other.ru', sitemapUrl: 'https://other.ru/sitemap.xml', pages: [page('/q', { url: 'https://other.ru/q', canonical: 'https://other.ru/q' })] }
  const task = buildTechnicalSeoFixTask(other, [{ severity: 'WARNING', code: 'title_missing', url: 'https://other.ru/q', message: 'Title is missing' }])!
  assert.ok(!task.includes('driveset.ru'))
  assert.ok(!task.includes('DriveSet'))
  assert.match(task, /Название: Other/)
})

test('repository line only when project metadata has it', () => {
  assert.doesNotMatch(buildTechnicalSeoFixTask(DRIVESET, [ROBOTS])!, /^- Repository\/path:/m) // no invented repository in PROJECT
  assert.match(buildTechnicalSeoFixTask({ ...DRIVESET, repository: 'RomanVaskin/driveset' }, [ROBOTS])!, /^- Repository\/path: RomanVaskin\/driveset/m)
})

test('the prompt starts with the mandatory read-the-docs block, before the work description', () => {
  const task = buildTechnicalSeoFixTask(DRIVESET, [ROBOTS])!
  const block = 'Перед работой прочитай AGENTS.md, OLNOO_PROJECT_MAP.md и OLNOO_ARCHITECTURE.md. Работай по зафиксированной production-карте. Если задача меняет системные факты — обнови документацию в том же commit.'
  assert.ok(task.includes(block))
  assert.ok(task.indexOf(block) < task.indexOf('Исправь найденные Technical SEO'))
  assert.ok(task.indexOf(block) < task.indexOf('PROJECT\n'))
})

test('repository choice: without Repository/path do not guess and verify the open repo; with it work only there', () => {
  const without = buildTechnicalSeoFixTask(DRIVESET, [ROBOTS])!
  assert.match(without, /Repository\/path не передан — НЕ угадывай репозиторий/)
  assert.match(without, /соответствует проекту «DriveSet» \(domain https:\/\/driveset\.ru\)/)
  assert.match(without, /остановись и сообщи, что нужен правильный repo\/path/)
  assert.doesNotMatch(without, /Работай только в репозитории/)
  const withRepo = buildTechnicalSeoFixTask({ ...DRIVESET, repository: 'RomanVaskin/driveset' }, [ROBOTS])!
  assert.match(withRepo, /Работай только в репозитории\/пути: RomanVaskin\/driveset\./)
  assert.doesNotMatch(withRepo, /НЕ угадывай/)
  assert.match(withRepo, /остановись и сообщи, что нужен правильный repo\/path/)
})

test('empty issues → no task (the Fix actions are not offered)', () => {
  assert.equal(buildTechnicalSeoFixTask(DRIVESET, []), null)
  const ui = readFileSync(new URL('../components/sections/seo-health.tsx', import.meta.url), 'utf8')
  // «Fix all» lives in the branch that renders only when the project has issues; the per-issue button is inside the issue list.
  assert.match(ui, /r\.issues\.length === 0 \? \(\s*<p[^>]*>\{t\.seoHealth\.noIssues\}<\/p>\s*\) : \(\s*<>\s*<button[^>]*onClick=\{\(\) => openFix\(r, r\.issues\)\}/)
  assert.match(ui, /openFix\(r, \[i\]\)/)
  assert.match(ui, /if \(text\) setFixPanel/)
})

test('the prompt never asks to write to repositories itself and keeps the safety rules', () => {
  const task = buildTechnicalSeoFixTask(DRIVESET, [ROBOTS])!
  for (const s of ['минимальным patch', 'не делай редизайн', 'чужие незакоммиченные изменения', 'Secrets и media в Git не добавляй', 'Не придумывай услуги, цены, города, гарантии']) assert.ok(task.includes(s), s)
})
