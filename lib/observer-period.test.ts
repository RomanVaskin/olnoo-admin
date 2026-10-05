import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moscowDay, resolveObserverPeriod } from './observer-period.ts'

// 2026-10-05 12:00 Moscow = 09:00 UTC
const NOW = new Date('2026-10-05T09:00:00Z')
const q = (s: string) => new URLSearchParams(s)

test('today: one Moscow day, explicitly incomplete', () => {
  assert.deepEqual(resolveObserverPeriod(q('period=today'), NOW), { from: '2026-10-05', to: '2026-10-05', timezone: 'Europe/Moscow', complete: false, preset: 'today' })
})

test('Moscow day rolls over at 21:00 UTC, not at UTC midnight', () => {
  assert.equal(moscowDay(new Date('2026-10-05T20:59:00Z')), '2026-10-05')
  assert.equal(moscowDay(new Date('2026-10-05T21:00:00Z')), '2026-10-06')
  const late = resolveObserverPeriod(q('period=yesterday'), new Date('2026-10-05T22:00:00Z'))
  assert.deepEqual(late, { from: '2026-10-05', to: '2026-10-05', timezone: 'Europe/Moscow', complete: true, preset: 'yesterday' })
})

test('yesterday and last7 (7 complete days before today) are complete', () => {
  assert.deepEqual(resolveObserverPeriod(q('period=yesterday'), NOW), { from: '2026-10-04', to: '2026-10-04', timezone: 'Europe/Moscow', complete: true, preset: 'yesterday' })
  assert.deepEqual(resolveObserverPeriod(q('period=last7'), NOW), { from: '2026-09-28', to: '2026-10-04', timezone: 'Europe/Moscow', complete: true, preset: 'last7' })
})

test('explicit from/to: strict dates, complete only when it ends before today', () => {
  const past = resolveObserverPeriod(q('from=2026-09-01&to=2026-09-30'), NOW)
  assert.deepEqual(past, { from: '2026-09-01', to: '2026-09-30', timezone: 'Europe/Moscow', complete: true, preset: 'custom' })
  const withToday = resolveObserverPeriod(q('from=2026-10-01&to=2026-10-05'), NOW)
  assert.ok(!('error' in withToday) && withToday.complete === false)
})

test('invalid input is a 400', () => {
  for (const s of [
    '', 'period=tomorrow', 'period=today&period=yesterday', 'period=today&from=2026-10-01&to=2026-10-02',
    'from=2026-10-01', 'to=2026-10-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-10-04&to=2026-10-01',
    'from=2026-10-01&to=2026-10-06', 'from=2026-01-01&to=2026-10-04', // future end; longer than 92 days
  ]) {
    const r = resolveObserverPeriod(q(s), NOW)
    assert.ok('error' in r && r.status === 400, `expected 400 for "${s}"`)
  }
})
