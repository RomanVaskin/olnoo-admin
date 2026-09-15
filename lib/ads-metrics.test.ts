import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateCpl, calculateCac, calculateRoi } from './ads-metrics.ts'

test('calculateCpl divides spend by leads', () => {
  assert.equal(calculateCpl(1000, 10), 100)
  assert.equal(calculateCpl(999, 3), 333)
})

test('calculateCpl returns null when there are no leads', () => {
  assert.equal(calculateCpl(1000, 0), null)
})

test('calculateCac divides spend by sales', () => {
  assert.equal(calculateCac(5000, 5), 1000)
})

test('calculateCac returns null when there are no sales', () => {
  assert.equal(calculateCac(5000, 0), null)
})

test('calculateRoi computes (revenue - spend) / spend * 100', () => {
  assert.equal(calculateRoi(2000, 1000), 100)
  assert.equal(calculateRoi(500, 1000), -50)
  assert.equal(calculateRoi(1000, 1000), 0)
})

test('calculateRoi returns null when spend is zero', () => {
  assert.equal(calculateRoi(1000, 0), null)
})
