// Period presets for the Metrika Observer: today / yesterday / last7 or an explicit from/to, as inclusive calendar
// days in Europe/Moscow. Explicit ranges reuse the CRM Observer's strict parser (`buildPeriod`); the Direct and CRM
// Observer endpoints keep their own query contracts and are not changed. No `@/` imports: runs under `node --test`.

import { buildPeriod, OBSERVER_TIMEZONE, type ObserverError } from './crm-observer.ts'

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000

export type PeriodPreset = 'today' | 'yesterday' | 'last7' | 'custom'

export type ResolvedPeriod = {
  from: string
  to: string
  timezone: typeof OBSERVER_TIMEZONE
  /** false while the period includes the current (unfinished) Moscow day. */
  complete: boolean
  preset: PeriodPreset
}

/** The Moscow calendar day `offsetDays` before `now`, as YYYY-MM-DD. */
export function moscowDay(now: Date, offsetDays = 0): string {
  const moscow = new Date(now.getTime() + MOSCOW_OFFSET_MS)
  return new Date(Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate() - offsetDays)).toISOString().slice(0, 10)
}

const bad = (error: string): ObserverError => ({ error, status: 400 })

/**
 * `period=today|yesterday|last7` (last7 = the 7 complete days before today) OR `from`+`to`, never both.
 * An explicit range may not end in the future; it is `complete` only if it ends before today.
 */
export function resolveObserverPeriod(params: URLSearchParams, now: Date = new Date()): ResolvedPeriod | ObserverError {
  const presets = params.getAll('period')
  const hasRange = params.has('from') || params.has('to')
  if (presets.length > 1) return bad('period must be given once')
  if (presets.length === 1 && hasRange) return bad('use either period or from/to, not both')
  const today = moscowDay(now)

  if (presets.length === 1) {
    switch (presets[0]) {
      case 'today':
        return { from: today, to: today, timezone: OBSERVER_TIMEZONE, complete: false, preset: 'today' }
      case 'yesterday': {
        const day = moscowDay(now, 1)
        return { from: day, to: day, timezone: OBSERVER_TIMEZONE, complete: true, preset: 'yesterday' }
      }
      case 'last7':
        return { from: moscowDay(now, 7), to: moscowDay(now, 1), timezone: OBSERVER_TIMEZONE, complete: true, preset: 'last7' }
      default:
        return bad('period must be today, yesterday or last7')
    }
  }
  if (!hasRange) return bad('period (today, yesterday, last7) or from and to are required')

  const range = buildPeriod(params.get('from'), params.get('to'))
  if ('error' in range) return range
  if (range.to > today) return bad('to must not be in the future')
  return { from: range.from, to: range.to, timezone: OBSERVER_TIMEZONE, complete: range.to < today, preset: 'custom' }
}

