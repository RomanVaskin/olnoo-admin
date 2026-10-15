import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  normalizeBrandVoice,
  brandVoiceBlock,
  brandVoiceIsEmpty,
  getProjectBrandVoice,
  saveProjectBrandVoice,
  BrandVoiceError,
  EMPTY_BRAND_VOICE,
} from './project-brand-voice.ts'

// --- Pure: normalizeBrandVoice / brandVoiceBlock / brandVoiceIsEmpty ---

test('normalizeBrandVoice: trims, caps length, and defaults unknown input to empty strings', () => {
  const voice = normalizeBrandVoice({
    targetAudience: '  Car owners in Astana  ',
    toneStyle: 'Friendly\nand  expert',
    verifiedFacts: 'Founded 2019\n- 5000+ cars serviced',
    constraints: 'Never promise same-day service',
    preferredCta: 'Book via WhatsApp',
  })
  assert.equal(voice.targetAudience, 'Car owners in Astana')
  assert.equal(voice.toneStyle, 'Friendly and  expert')
  assert.equal(voice.verifiedFacts, 'Founded 2019\n- 5000+ cars serviced')
  assert.equal(voice.constraints, 'Never promise same-day service')
  assert.equal(voice.preferredCta, 'Book via WhatsApp')
})

test('normalizeBrandVoice: non-object input becomes EMPTY_BRAND_VOICE', () => {
  assert.deepEqual(normalizeBrandVoice(null), EMPTY_BRAND_VOICE)
  assert.deepEqual(normalizeBrandVoice('nonsense'), EMPTY_BRAND_VOICE)
  assert.deepEqual(normalizeBrandVoice(undefined), EMPTY_BRAND_VOICE)
})

test('normalizeBrandVoice: a single-line field over its cap is truncated', () => {
  const voice = normalizeBrandVoice({ toneStyle: 'x'.repeat(500) })
  assert.equal(voice.toneStyle.length, 200)
})

test('brandVoiceIsEmpty: true for null and for an all-empty voice, false once any field is set', () => {
  assert.equal(brandVoiceIsEmpty(null), true)
  assert.equal(brandVoiceIsEmpty(EMPTY_BRAND_VOICE), true)
  assert.equal(brandVoiceIsEmpty({ ...EMPTY_BRAND_VOICE, preferredCta: 'Call us' }), false)
})

test('brandVoiceBlock: renders "(not specified)" placeholders for an empty/null voice', () => {
  const block = brandVoiceBlock(null)
  assert.ok(block.includes('(not specified)'))
  assert.ok(block.includes('TARGET AUDIENCE:'))
  assert.ok(block.includes('CONSTRAINTS'))
})

test('brandVoiceBlock: lists verifiedFacts/constraints one bullet per line, never flattened', () => {
  const block = brandVoiceBlock({
    targetAudience: 'Car owners',
    toneStyle: 'Expert, friendly',
    verifiedFacts: 'Founded 2019\nOver 5000 cars serviced',
    constraints: 'Never promise same-day service\nNever claim to be the cheapest',
    preferredCta: 'Book via WhatsApp',
  })
  assert.ok(block.includes('- Founded 2019'))
  assert.ok(block.includes('- Over 5000 cars serviced'))
  assert.ok(block.includes('- Never promise same-day service'))
  assert.ok(block.includes('- Never claim to be the cheapest'))
  assert.ok(block.includes('Book via WhatsApp'))
})

// --- DB integration (skipped without a reachable Postgres with migration 0028 applied) ---

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(t: import('node:test').TestContext, fn: (pool: Pool, makeProject: () => Promise<number>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT project_id FROM project_brand_voice LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the project_brand_voice schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientIds: number[] = []
  const makeProject = async () => {
    const clientId = (
      await pool.query(`INSERT INTO clients (name) VALUES ('__test_brand_voice__' || clock_timestamp()::text) RETURNING id`)
    ).rows[0].id as number
    clientIds.push(clientId)
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    return (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        'brand voice test',
        `${slug}.example`,
        slug,
      ])
    ).rows[0].id as number
  }
  try {
    await fn(pool, makeProject)
  } finally {
    for (const clientId of clientIds) {
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    }
    await pool.end()
  }
}

test('getProjectBrandVoice: null for a project with no saved Brand Profile', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject()
    assert.equal(await getProjectBrandVoice(pool, projectId), null)
  })
})

test('saveProjectBrandVoice then getProjectBrandVoice round-trips, and a second save replaces rather than duplicates', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject()
    const saved = await saveProjectBrandVoice(pool, projectId, {
      targetAudience: 'Car owners',
      toneStyle: 'Expert, friendly',
      verifiedFacts: 'Founded 2019',
      constraints: 'Never promise same-day service',
      preferredCta: 'Book via WhatsApp',
    })
    assert.equal(saved.targetAudience, 'Car owners')
    assert.deepEqual(await getProjectBrandVoice(pool, projectId), saved)

    const updated = await saveProjectBrandVoice(pool, projectId, { ...saved, preferredCta: 'Call us' })
    assert.equal(updated.preferredCta, 'Call us')
    assert.deepEqual(await getProjectBrandVoice(pool, projectId), updated)

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM project_brand_voice WHERE project_id = $1', [projectId])
    assert.equal(rows[0].n, 1, 'a second save must update the one row, never insert a second')
  })
})

test('saveProjectBrandVoice: an unknown project is refused with BrandVoiceError, nothing written', async (t) => {
  await withDb(t, async (pool) => {
    await assert.rejects(() => saveProjectBrandVoice(pool, 999999999, { toneStyle: 'x' }), BrandVoiceError)
  })
})

test('requirement: project isolation — Brand Profile saved for project A never appears under project B', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectA = await makeProject()
    const projectB = await makeProject()
    await saveProjectBrandVoice(pool, projectA, { toneStyle: 'For project A only', preferredCta: 'A-only CTA' })

    const voiceB = await getProjectBrandVoice(pool, projectB)
    assert.equal(voiceB, null, "project B must see no Brand Profile — project A's must never leak across")
  })
})
