import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMergeResponse, planBatches, stem, stemSignature, UnitGroups } from './seo-clustering-batch.ts'

test('5 200 keywords → batches of at most 250, every keyword exactly once, same text never split', () => {
  const keywords = Array.from({ length: 5200 }, (_, i) => ({ id: i + 1, query: `оклейка авто вариант ${Math.floor(i / 2)}`, frequency: i }))
  const batches = planBatches(keywords, { batchSize: 250 })
  assert.equal(batches.length, Math.ceil(5200 / 250))
  assert.ok(batches.every((b) => b.length <= 250))
  const ids = batches.flat().map((k) => k.id)
  assert.equal(ids.length, 5200)
  assert.equal(new Set(ids).size, 5200)
  // Pairs share a query text (two Wordstat regions) and must land in the same batch.
  const batchOf = new Map(batches.flatMap((b, i) => b.map((k) => [k.id, i] as const)))
  for (let i = 1; i <= 5200; i += 2) assert.equal(batchOf.get(i), batchOf.get(i + 1))
})

test('the character cap also splits batches', () => {
  const keywords = Array.from({ length: 100 }, (_, i) => ({ id: i, query: `${'очень длинный запрос '.repeat(10)}${i}`, frequency: 1 }))
  const batches = planBatches(keywords, { batchSize: 250, maxChars: 5000 })
  assert.ok(batches.length > 1)
  assert.equal(batches.flat().length, 100)
})

test('word forms share a stem signature; different services do not', () => {
  assert.equal(stem('оклейка'), stem('оклейки'))
  assert.equal(stemSignature('оклейки авто'), stemSignature('авто оклейка'))
  assert.equal(stemSignature('пленка для авто'), stemSignature('пленки авто'))
  assert.notEqual(stemSignature('оклейка авто'), stemSignature('полировка авто'))
})

test('merge answer: unknown ids dropped, an id is used once, singletons ignored, bad JSON is null', () => {
  const known = new Set(['u1', 'u2', 'u3', 'u4'])
  const groups = parseMergeResponse(
    JSON.stringify({
      groups: [
        { ids: ['u1', 'u2', 'x9'], name: 'Оклейка авто', primaryKeyword: 'оклейка авто', intent: 'commercial' },
        { ids: ['u2', 'u3'], name: 'dup' },
        { ids: ['u4'], name: 'single' },
      ],
    }),
    known,
  )
  assert.deepEqual(groups?.map((g) => g.ids), [['u1', 'u2']])
  assert.equal(parseMergeResponse('not json', known), null)
  assert.deepEqual(parseMergeResponse('```json\n{"groups": []}\n```', known), [])
})

test('two human-reviewed clusters are never merged together', () => {
  const g = new UnitGroups([
    { uid: 'r1', fixed: true },
    { uid: 'r2', fixed: true },
    { uid: 'a', fixed: false },
  ])
  assert.equal(g.union('a', 'r1'), true)
  assert.equal(g.union('a', 'r2'), false)
  assert.equal(g.find('a'), 'r1')
  assert.equal(g.roots().length, 2)
})
