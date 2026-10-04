import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLeadAttribution, type LeadAttribution, type LeadAttributionError } from './lead-attribution.ts'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const UUID = '0b6f4c1e-5d4a-4f0e-9a3b-7c2d1e8f9a10'
const ok = (input: Parameters<typeof parseLeadAttribution>[0]) => {
  const r = parseLeadAttribution(input, NOW)
  assert.ok(!('error' in r), `unexpected error: ${JSON.stringify(r)}`)
  return r as LeadAttribution
}
const bad = (input: Parameters<typeof parseLeadAttribution>[0]) => {
  const r = parseLeadAttribution(input, NOW)
  assert.ok('error' in r, 'expected an error')
  assert.equal((r as LeadAttributionError).status, 400)
  return (r as LeadAttributionError).error
}

test('an old client sends none of the fields: everything is null, nothing blocks the lead', () => {
  const none = { leadTrackingId: null, metrikaClientId: null, yclid: null, firstSeenAt: null }
  assert.deepEqual(ok({}), none)
  assert.deepEqual(ok({ leadTrackingId: null, metrikaClientId: null, yclid: null, firstSeenAt: null }), none)
  // DriveSet sends "" for an empty value — also "not provided", not an error
  assert.deepEqual(ok({ leadTrackingId: '', metrikaClientId: '  ', yclid: '', firstSeenAt: '' }), none)
})

test('all four fields: stored values are normalised', () => {
  const r = ok({ leadTrackingId: UUID.toUpperCase(), metrikaClientId: '1712345678901234567', yclid: 'abc123-xyz', firstSeenAt: '2026-10-04T21:00:00+03:00' })
  assert.deepEqual(r, {
    leadTrackingId: UUID, // lower-cased
    metrikaClientId: '1712345678901234567',
    yclid: 'abc123-xyz',
    firstSeenAt: '2026-10-04T18:00:00.000Z', // converted to UTC
  })
})

test('ClientID stays a string and keeps every digit (UInt64, beyond the JS safe-integer range)', () => {
  const max = '18446744073709551615' // 2^64 - 1
  assert.equal(Number(max).toString() === max, false, 'this value does not survive Number()')
  assert.equal(ok({ metrikaClientId: max }).metrikaClientId, max)
  assert.equal(typeof ok({ metrikaClientId: '1' }).metrikaClientId, 'string')
  bad({ metrikaClientId: 1712345678901234567 }) // a JSON number has already lost precision: rejected
})

test('invalid ClientID is rejected', () => {
  for (const v of ['abc', '12a', '-1', '1.5', '1e5', '0x10', '123456789012345678901', '１２３', '12 34']) bad({ metrikaClientId: v })
  bad({ metrikaClientId: {} })
  bad({ metrikaClientId: ['1'] })
  bad({ metrikaClientId: true })
})

test('invalid lead_tracking_id is rejected', () => {
  for (const v of ['not-a-uuid', '0b6f4c1e5d4a4f0e9a3b7c2d1e8f9a10', `${UUID}x`, ` ${UUID}z`, '0b6f4c1e-5d4a-4f0e-9a3b-7c2d1e8f9a1', '00000000-0000-0000-0000-00000000000g']) bad({ leadTrackingId: v })
  bad({ leadTrackingId: 123 })
  bad({ leadTrackingId: {} })
})

test('invalid first_seen_at is rejected', () => {
  for (const v of ['yesterday', '2026-10-04', '2026-10-04T10:00:00', '2026-13-04T10:00:00Z', '2026-02-30T10:00:00Z', '2026-04-31T10:00:00Z', '2026-10-04T24:00:00Z', '2026-10-04T10:60:00Z', '1712345678', '2019-12-31T23:59:59Z', '2026-10-07T12:00:01Z']) bad({ firstSeenAt: v })
  bad({ firstSeenAt: 1712345678000 })
  assert.equal(ok({ firstSeenAt: '2026-10-05T12:00:00.123Z' }).firstSeenAt, '2026-10-05T12:00:00.123Z')
  assert.equal(ok({ firstSeenAt: '2026-10-06T11:59:59Z' }).firstSeenAt, '2026-10-06T11:59:59.000Z') // within the 24 h clock-skew allowance
})

test('yclid: opaque, bounded, no whitespace or control characters', () => {
  assert.equal(ok({ yclid: '1'.repeat(200) }).yclid?.length, 200)
  bad({ yclid: '1'.repeat(201) })
  bad({ yclid: 'a b' })
  bad({ yclid: 'a\nb' })
  bad({ yclid: 'a\u0000b' })
  bad({ yclid: 12345 })
})

test('error messages and console output never contain the submitted identifiers', () => {
  const secrets = { leadTrackingId: 'SECRET-TRACKING', metrikaClientId: 'SECRET-CLIENT-9', yclid: 'SECRET YCLID', firstSeenAt: 'SECRET-TIME' }
  const captured: string[] = []
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  for (const k of Object.keys(originals) as (keyof typeof originals)[]) console[k] = (...args: unknown[]) => void captured.push(args.map(String).join(' '))
  try {
    for (const key of Object.keys(secrets) as (keyof typeof secrets)[]) {
      const message = bad({ [key]: secrets[key] })
      for (const secret of Object.values(secrets)) assert.ok(!message.includes(secret), `error text leaked ${key}`)
    }
  } finally {
    Object.assign(console, originals)
  }
  assert.deepEqual(captured, [])
})
