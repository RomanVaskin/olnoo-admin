import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  decideSeoActions,
  normalizeDecisionQuery,
  PAGE_BLOCKING_CODES,
  PROJECT_BLOCKING_CODES,
  SEO_DECISION_THRESHOLDS,
  type DecisionCluster,
  type DecisionInput,
  type SeoDecision,
} from './seo-decision-rules.ts'
import { buildDecisionInput } from './seo-decision-input.ts'

const D = 'https://x.ru'
const PAGES = [{ id: 1, url: `${D}/a` }, { id: 2, url: `${D}/b` }, { id: 3, url: `${D}/c` }]
const cluster = (id: number, keywords: string[], over: Partial<DecisionCluster> = {}): DecisionCluster => ({
  id, name: `cluster ${id}`, intent: 'commercial', reviewStatus: 'confirmed', confirmedPageId: 1, keywords: keywords.map((query) => ({ query })), ...over,
})
const q = (query: string, impressions: number, clicks = 0, avgPosition: number | null = 15) => ({ query, impressions, clicks, avgPosition })
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  projectId: 7, technicalIssues: [], webmasterQueries: [], organicPages: null, clusters: [], pages: PAGES, ...over,
})
const acts = (ds: SeoDecision[]) => ds.map((d) => d.action)
const of = (ds: SeoDecision[], action: string) => ds.filter((d) => d.action === action)

// A
test('A. strict priority: a project-level blocking issue → FIX only, no IMPROVE / CREATE / IGNORE for its clusters', () => {
  const ds = decideSeoActions(input({
    technicalIssues: [{ code: 'sitemap_missing' }, { code: 'canonical_missing', url: `${D}/a` }],
    webmasterQueries: [q('полировка', 100, 10, 12)],
    clusters: [cluster(1, ['полировка']), cluster(2, ['стекло'], { reviewStatus: 'no_page', confirmedPageId: null }), cluster(3, ['x'], { reviewStatus: 'ignored', confirmedPageId: null })],
  }))
  assert.deepEqual(acts(ds), ['FIX'])
  assert.deepEqual(ds[0].evidence.issueCodes, ['sitemap_missing'])
  for (const code of ['site_unavailable', 'robots_disallow_all', 'sitemap_missing', 'sitemap_unreadable', 'check_failed']) assert.ok(PROJECT_BLOCKING_CODES.has(code), code)
  for (const code of ['page_unreachable', 'page_http_error', 'noindex_in_sitemap']) assert.ok(PAGE_BLOCKING_CODES.has(code), code)
  for (const code of ['canonical_missing', 'h1_missing', 'title_missing', 'page_redirect', 'robots_missing']) assert.ok(!PROJECT_BLOCKING_CODES.has(code) && !PAGE_BLOCKING_CODES.has(code), code) // warnings never block
})

// B
test('B. page blocking: /a unreachable → FIX for /a only; /b can still be IMPROVEd', () => {
  const ds = decideSeoActions(input({
    technicalIssues: [{ code: 'page_unreachable', url: `${D}/a` }],
    webmasterQueries: [q('ключ а', 50, 5, 12), q('ключ б', 50, 5, 12)],
    clusters: [cluster(1, ['ключ а'], { confirmedPageId: 1 }), cluster(2, ['ключ б'], { confirmedPageId: 2 })],
  }))
  assert.deepEqual(acts(ds), ['FIX', 'IMPROVE'])
  assert.deepEqual([ds[0].pageId, ds[1].pageId], [1, 2])
  assert.deepEqual(ds[0].evidence.issueCodes, ['page_unreachable'])
})

// C
test('C. IGNORE: a human-ignored cluster is IGNORE whatever its metrics are', () => {
  const ds = decideSeoActions(input({ webmasterQueries: [q('полировка', 500, 50, 10)], clusters: [cluster(1, ['полировка'], { reviewStatus: 'ignored', confirmedPageId: null })] }))
  assert.deepEqual(acts(ds), ['IGNORE'])
  assert.equal(ds[0].reason, 'human_ignored')
})

test('IGNORE by AI relevance only for UNREVIEWED clusters with every keyword explicitly bad; null / mixed / human-reviewed are not ignored', () => {
  const kw = (relevanceStatus: string | null) => ({ query: 'k' + String(relevanceStatus), relevanceStatus })
  const make = (id: number, keywords: ReturnType<typeof kw>[], over: Partial<DecisionCluster> = {}): DecisionCluster => ({ id, name: 'c', intent: 'commercial', reviewStatus: 'pending', confirmedPageId: null, keywords, ...over })
  const run = (c: DecisionCluster) => acts(decideSeoActions(input({ clusters: [c] })))
  assert.deepEqual(run(make(1, [kw('irrelevant'), kw('geo_mismatch'), kw('uncertain')])), ['IGNORE'])
  assert.deepEqual(run(make(2, [kw('irrelevant'), kw(null)])), []) // unknown relevance is not "ignored"
  assert.deepEqual(run(make(3, [kw('irrelevant'), kw('target')])), []) // mixed
  assert.deepEqual(run(make(4, [kw('irrelevant')], { reviewStatus: 'confirmed', confirmedPageId: 1 })), ['NONE']) // human confirmed wins over AI history
  assert.deepEqual(run(make(5, [])), [])
})

// D / E / F
test('D. IMPROVE: confirmed page, 10+ impressions, weighted position 8–30', () => {
  const ds = decideSeoActions(input({ webmasterQueries: [q('полировка кузова', 124, 6, 14.2)], clusters: [cluster(1, ['Полировка  кузова'])] }))
  assert.deepEqual(acts(ds), ['IMPROVE'])
  assert.deepEqual([ds[0].pageId, ds[0].pageUrl, ds[0].evidence.impressions, ds[0].evidence.clicks, ds[0].evidence.avgPosition, ds[0].evidence.ctr], [1, `${D}/a`, 124, 6, 14.2, 4.84])
})

test('E. not enough impressions (9) → no IMPROVE; the threshold is exactly 10', () => {
  const run = (n: number) => acts(decideSeoActions(input({ webmasterQueries: [q('k', n, 0, 15)], clusters: [cluster(1, ['k'])] })))
  assert.deepEqual(run(9), ['NONE'])
  assert.deepEqual(run(10), ['IMPROVE'])
  assert.deepEqual([SEO_DECISION_THRESHOLDS.minImpressions, SEO_DECISION_THRESHOLDS.improvePositionMin, SEO_DECISION_THRESHOLDS.improvePositionMax], [10, 8, 30])
})

test('F. position boundaries: 7.9 no, 8 yes, 30 yes, 30.1 no', () => {
  const run = (pos: number) => acts(decideSeoActions(input({ webmasterQueries: [q('k', 50, 1, pos)], clusters: [cluster(1, ['k'])] })))
  assert.deepEqual([7.9, 8, 30, 30.1].map(run), [['NONE'], ['IMPROVE'], ['IMPROVE'], ['NONE']])
})

test('weighted position (by impressions) and CTR from sums, not an average of row CTRs', () => {
  const ds = decideSeoActions(input({ webmasterQueries: [q('a', 90, 9, 10), q('b', 10, 1, 40), q('c', 0, 0, 5)], clusters: [cluster(1, ['a', 'b', 'c'])] }))
  assert.deepEqual([ds[0].action, ds[0].evidence.impressions, ds[0].evidence.avgPosition, ds[0].evidence.ctr, ds[0].evidence.matchedQueries], ['IMPROVE', 100, 13, 10, 3])
  const none = decideSeoActions(input({ webmasterQueries: [q('a', 0, 0, null)], clusters: [cluster(1, ['a'])] }))
  assert.equal(none[0].evidence.avgPosition, null) // no impressions → null position
})

// G / H
test('G. query normalisation: case, whitespace and ё/е match exactly', () => {
  assert.equal(normalizeDecisionQuery('  Полировка\t ЁЛКИ  '), 'полировка елки')
  const ds = decideSeoActions(input({ webmasterQueries: [q('  ПОЛИРОВКА   ёлки ', 30, 1, 12)], clusters: [cluster(1, ['полировка елки'])] }))
  assert.deepEqual(acts(ds), ['IMPROVE'])
})

test('H. no fuzzy: «полировка авто» does not match «полировка автомобиля»', () => {
  const ds = decideSeoActions(input({ webmasterQueries: [q('полировка автомобиля', 500, 50, 12)], clusters: [cluster(1, ['полировка авто'])] }))
  assert.deepEqual([ds[0].action, ds[0].evidence.matchedQueries, ds[0].evidence.impressions], ['NONE', 0, 0])
})

// I
test('I. one page → exactly ONE IMPROVE with all its clusterIds; a shared query is counted once', () => {
  const ds = decideSeoActions(input({
    webmasterQueries: [q('полировка кузова', 60, 3, 12), q('полировка фар', 40, 2, 20), q('общий запрос', 20, 1, 10)],
    clusters: [cluster(1, ['полировка кузова', 'общий запрос']), cluster(2, ['полировка фар', 'общий запрос']), cluster(3, ['другое'], { confirmedPageId: 2 })],
  }))
  const improve = of(ds, 'IMPROVE')
  assert.equal(improve.length, 1)
  assert.deepEqual(improve[0].evidence.clusterIds, [1, 2])
  assert.deepEqual([improve[0].evidence.impressions, improve[0].evidence.matchedQueries], [120, 3]) // «общий запрос» once
  assert.equal(improve[0].pageId, 1)
})

// J / K
test('J. CREATE candidate: a human no_page cluster; Webmaster stats are optional evidence', () => {
  const noStats = decideSeoActions(input({ webmasterQueries: null, clusters: [cluster(5, ['полировка стекла'], { reviewStatus: 'no_page', confirmedPageId: null })] }))
  assert.deepEqual([noStats[0].action, noStats[0].clusterId, noStats[0].reason, noStats[0].evidence], ['CREATE_CANDIDATE', 5, 'human_no_page', {}])
  const withStats = decideSeoActions(input({ webmasterQueries: [q('полировка стекла', 5, 0, 40)], clusters: [cluster(5, ['полировка стекла'], { reviewStatus: 'no_page', confirmedPageId: null })] }))
  assert.deepEqual([withStats[0].action, withStats[0].evidence.impressions, withStats[0].evidence.avgPosition], ['CREATE_CANDIDATE', 5, 40])
  assert.deepEqual(acts(decideSeoActions(input({ clusters: [cluster(6, ['k'], { reviewStatus: 'no_page', confirmedPageId: null, intent: 'navigational' })] }))), ['NONE'])
})

test('K. pending cluster (even with an AI "create" decision) is never a CREATE candidate', () => {
  const pending = { ...cluster(5, ['k'], { reviewStatus: 'pending', confirmedPageId: null }), aiDecision: 'create' } as DecisionCluster
  assert.deepEqual(decideSeoActions(input({ webmasterQueries: [q('k', 100, 5, 10)], clusters: [pending] })), [])
})

// L
test('L. cannibalisation guard: a no_page keyword that exactly overlaps a confirmed cluster → NONE possible_existing_page_overlap', () => {
  const ds = decideSeoActions(input({ clusters: [cluster(1, ['Полировка кузова'], { confirmedPageId: 1 }), cluster(2, ['полировка   кузова', 'другое'], { reviewStatus: 'no_page', confirmedPageId: null })] }))
  assert.deepEqual(of(ds, 'CREATE_CANDIDATE'), [])
  const none = of(ds, 'NONE').find((d) => d.clusterId === 2)!
  assert.deepEqual([none.reason, none.pageId], ['possible_existing_page_overlap', 1])
})

// M
test('M. no Webmaster snapshot: FIX / IGNORE / CREATE_CANDIDATE still work, IMPROVE does not', () => {
  const ds = decideSeoActions(input({
    technicalIssues: [{ code: 'page_http_error', url: `${D}/c` }],
    webmasterQueries: null,
    clusters: [cluster(1, ['k']), cluster(2, ['i'], { reviewStatus: 'ignored', confirmedPageId: null }), cluster(3, ['n'], { reviewStatus: 'no_page', confirmedPageId: null })],
  }))
  assert.deepEqual(acts(ds), ['FIX', 'IGNORE', 'CREATE_CANDIDATE', 'NONE'])
  assert.equal(of(ds, 'NONE')[0].reason, 'no_webmaster_snapshot')
  assert.equal(of(ds, 'IMPROVE').length, 0)
})

// N
test('N. Metrika visits attach only by the exact page URL as page evidence, and never change the query numbers', () => {
  const base = { webmasterQueries: [q('k', 50, 5, 12)], clusters: [cluster(1, ['k'])] }
  const without = decideSeoActions(input(base))[0]
  const withVisits = decideSeoActions(input({ ...base, organicPages: [{ url: `${D}/a/`, visits: 33 }, { url: `${D}/b`, visits: 999 }] }))[0]
  assert.equal(withVisits.evidence.organicVisits, 33) // trailing slash normalised, /b is another page
  assert.deepEqual({ ...withVisits.evidence, organicVisits: undefined }, { ...without.evidence, organicVisits: undefined })
  const zero = decideSeoActions(input({ ...base, organicPages: [{ url: `${D}/a`, visits: 0 }] }))[0]
  assert.equal(zero.action, 'IMPROVE') // 0 visits do not block
  assert.equal(decideSeoActions(input({ ...base, organicPages: [{ url: `${D}/ab`, visits: 5 }] }))[0].evidence.organicVisits, undefined) // no fuzzy URL match
})

// O
test('O. no writes: the decision module has no DB / network / env / clock / AI dependencies', () => {
  for (const f of ['./seo-decision-rules.ts', './seo-decision-input.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /from 'pg'|\bpool\b|\bfetch\(|process\.env|Date\.now|new Date\(|ai-router|INSERT|UPDATE|DELETE/, f)
  }
  assert.doesNotMatch(readFileSync(new URL('./seo-decision-store.ts', import.meta.url), 'utf8'), /INSERT|UPDATE|DELETE|saveSeoSnapshot|runSeoObserver/)
  const route = readFileSync(new URL('../app/api/seo-decisions/route.ts', import.meta.url), 'utf8')
  assert.match(route, /export async function GET/)
  assert.doesNotMatch(route, /export (async function|const) (POST|PUT|PATCH|DELETE)/)
  assert.doesNotMatch(route, /ConfigFromEnv|createWebmasterClient|createMetrikaClient/) // no provider call
})

test('output order is FIX → IGNORE → IMPROVE → CREATE_CANDIDATE → NONE and the function is deterministic', () => {
  const inp = input({
    technicalIssues: [{ code: 'noindex_in_sitemap', url: `${D}/c` }],
    webmasterQueries: [q('k', 50, 5, 12)],
    clusters: [cluster(9, ['n'], { reviewStatus: 'no_page', confirmedPageId: null }), cluster(1, ['k']), cluster(2, ['i'], { reviewStatus: 'ignored', confirmedPageId: null }), cluster(3, ['x'], { confirmedPageId: 3 })],
  })
  const a = decideSeoActions(inp)
  assert.deepEqual(acts(a), ['FIX', 'IGNORE', 'IMPROVE', 'CREATE_CANDIDATE'])
  assert.deepEqual(decideSeoActions(inp), a)
})

test('adapter: stored snapshot shapes map to decision input; malformed rows are dropped; absent snapshots stay null', () => {
  const snap = (provider: 'yandex_webmaster' | 'yandex_metrika', kind: 'queries' | 'organic_pages', rows: unknown[]) => ({ id: 1, provider, kind, dateFrom: '2026-09-09', dateTo: '2026-10-06', takenAt: '2026-10-07T00:00:00Z', rows })
  const built = buildDecisionInput({
    projectId: 7,
    technicalIssues: null,
    snapshots: [snap('yandex_webmaster', 'queries', [{ query: 'a', impressions: 10, clicks: 1, ctr: 10, avgPosition: 9 }, null, { query: 5 }, { query: 'b', impressions: 'x' }]), snap('yandex_metrika', 'organic_pages', [{ path: '/a', url: `${D}/a`, visits: 4 }, { url: 3 }])],
    clusters: [{ id: 1, name: 'c', intent: 'commercial', reviewStatus: 'pending', confirmedPageId: null, keywords: [{ id: 10, query: 'k', frequency: 1 }] } as never],
    pages: PAGES,
    relevanceByKeywordId: new Map([[10, 'irrelevant']]),
  })
  assert.deepEqual(built.webmasterQueries, [{ query: 'a', impressions: 10, clicks: 1, avgPosition: 9 }])
  assert.deepEqual(built.organicPages, [{ url: `${D}/a`, visits: 4 }])
  assert.equal(built.clusters[0].keywords[0].relevanceStatus, 'irrelevant')
  const empty = buildDecisionInput({ projectId: 7, technicalIssues: null, snapshots: [], clusters: [], pages: [], relevanceByKeywordId: new Map() })
  assert.deepEqual([empty.webmasterQueries, empty.organicPages, empty.technicalIssues], [null, null, null])
})
