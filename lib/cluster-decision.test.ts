import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayStatus, showCreateSuggestion, type ClusterDecisionInput } from './cluster-decision.ts'
import { clusterLocale, pagesForLocale, searchPages, type PageOption } from './cluster-pages.ts'

const aiCreate: ClusterDecisionInput = { status: 'No page', reviewStatus: 'pending', confirmedPageId: null, aiDecision: 'create' }

test('AI create is shown as «Нет страницы» with its proposal until a human decides', () => {
  assert.equal(displayStatus(aiCreate), 'No page')
  assert.equal(showCreateSuggestion(aiCreate), true)
})

test('human decision overrides AI=create: a chosen existing page → «Есть страница», proposal hidden, AI kept as history', () => {
  const confirmed: ClusterDecisionInput = { ...aiCreate, reviewStatus: 'confirmed', confirmedPageId: 7 }
  assert.equal(displayStatus(confirmed), 'Existing page')
  assert.equal(showCreateSuggestion(confirmed), false)
  assert.equal(confirmed.aiDecision, 'create')
})

test('human no_page / ignored beat an AI «Existing page»; human no_page keeps the CREATE proposal, ignored hides it', () => {
  const aiImprove: ClusterDecisionInput = { status: 'Existing page', reviewStatus: 'pending', confirmedPageId: null, aiDecision: 'improve' }
  assert.equal(displayStatus({ ...aiImprove, reviewStatus: 'no_page' }), 'No page')
  assert.equal(displayStatus({ ...aiImprove, reviewStatus: 'ignored' }), 'Ignored')
  assert.equal(showCreateSuggestion({ ...aiCreate, reviewStatus: 'no_page' }), true)
  assert.equal(showCreateSuggestion({ ...aiCreate, reviewStatus: 'ignored' }), false)
})

test('«Полировка фар» (RU, AI=create) can find the neutral /polirovka-avto by search', () => {
  const pages: PageOption[] = [
    { id: 1, url: 'https://driveset.ru/polirovka-avto', locale: null, title: 'Полировка авто', h1: null, description: null },
    { id: 2, url: 'https://driveset.ru/en/polishing', locale: null, title: 'Polishing', h1: null, description: null },
  ]
  const cluster = { name: 'Полировка фар', primaryKeyword: 'полировка фар', recommendedPageId: null, recommendedPageUrl: null }
  const found = searchPages(pagesForLocale(pages, clusterLocale(cluster, pages)), 'polirovka')
  assert.deepEqual(found.map((p) => p.id), [1])
})

import { hasHumanDecision, showNoPagePlaceholder } from './cluster-decision.ts'

test('«Нет страницы» is never the main text of a row with a confirmed page (row and detail use the same block)', () => {
  const confirmed: ClusterDecisionInput = { status: 'No page', reviewStatus: 'confirmed', confirmedPageId: 7, aiDecision: 'create' }
  assert.equal(showNoPagePlaceholder(confirmed, 0), false, 'no placeholder even when there are no recommended candidates')
  assert.equal(displayStatus(confirmed), 'Existing page')
  assert.equal(hasHumanDecision(confirmed), true, 'the AI result is shown as history («AI ранее»)')
})

test('placeholder stays for a genuinely page-less cluster; ignored never shows it; pending AI result is not "history"', () => {
  assert.equal(showNoPagePlaceholder(aiCreate, 0), true)
  assert.equal(showNoPagePlaceholder(aiCreate, 2), false, 'candidates are listed instead')
  assert.equal(showNoPagePlaceholder({ ...aiCreate, reviewStatus: 'ignored' }, 0), false)
  assert.equal(hasHumanDecision(aiCreate), false)
  assert.equal(hasHumanDecision({ ...aiCreate, reviewStatus: 'no_page' }), true)
})
