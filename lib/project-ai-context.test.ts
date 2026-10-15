import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { buildProjectAiContext, projectAiContextBlock } from './project-ai-context.ts'
import { saveProjectBrandVoice } from './project-brand-voice.ts'
import { saveProjectSeoContext } from './project-seo-context.ts'

// --- Pure: projectAiContextBlock ---

test('projectAiContextBlock: renders project identity, Brand Profile, and verified SEO context sections', () => {
  const block = projectAiContextBlock({
    projectId: 1,
    name: 'DriveSet',
    domain: 'driveset.example',
    brandVoice: { targetAudience: 'Car owners', toneStyle: 'Expert, friendly', verifiedFacts: '', constraints: '', preferredCta: '' },
    seoContext: null,
  })
  assert.ok(block.startsWith('PROJECT: DriveSet (driveset.example)'))
  assert.ok(block.includes('BRAND PROFILE:'))
  assert.ok(block.includes('TARGET AUDIENCE: Car owners'))
  assert.ok(block.includes('VERIFIED SEO CONTEXT:'))
})

test('projectAiContextBlock: requirement — never hardcodes OLNOO as the subject for a different project', () => {
  const block = projectAiContextBlock({
    projectId: 1,
    name: 'DriveSet',
    domain: 'driveset.example',
    brandVoice: null,
    seoContext: null,
  })
  assert.ok(!block.includes('OLNOO'), 'DriveSet\'s own context block must never mention OLNOO')
})

test('projectAiContextBlock: an unknown/missing project still renders a usable block', () => {
  const block = projectAiContextBlock({ projectId: 1, name: '', domain: '', brandVoice: null, seoContext: null })
  assert.ok(block.includes('(unknown project)'))
})

// --- DB integration (skipped without a reachable Postgres) ---

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(t: import('node:test').TestContext, fn: (pool: Pool, makeProject: (name: string) => Promise<number>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT project_id FROM project_brand_voice LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the project_brand_voice schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientIds: number[] = []
  const makeProject = async (name: string) => {
    const clientId = (
      await pool.query(`INSERT INTO clients (name) VALUES ('__test_ai_context__' || clock_timestamp()::text) RETURNING id`)
    ).rows[0].id as number
    clientIds.push(clientId)
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    return (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        name,
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

test('buildProjectAiContext: combines project identity, Brand Profile, and SEO context for one project', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('DriveSet')
    await saveProjectBrandVoice(pool, projectId, { toneStyle: 'Expert, friendly', preferredCta: 'Book via WhatsApp' })
    await saveProjectSeoContext(pool, projectId, { businessType: 'Car detailing', region: 'Astana' })

    const ctx = await buildProjectAiContext(pool, projectId)
    assert.equal(ctx.name, 'DriveSet')
    assert.equal(ctx.brandVoice?.toneStyle, 'Expert, friendly')
    assert.equal(ctx.seoContext?.businessType, 'Car detailing')

    const block = projectAiContextBlock(ctx)
    assert.ok(block.includes('DriveSet'))
    assert.ok(block.includes('Book via WhatsApp'))
    assert.ok(block.includes('Car detailing'))
  })
})

test('requirement: project isolation — context built for project A never includes project B\'s Brand Profile or SEO context', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectA = await makeProject('DriveSet')
    const projectB = await makeProject('CleanTrack')
    await saveProjectBrandVoice(pool, projectA, { toneStyle: 'For DriveSet only', preferredCta: 'DriveSet-only CTA' })
    await saveProjectSeoContext(pool, projectA, { businessType: 'Car detailing' })
    await saveProjectBrandVoice(pool, projectB, { toneStyle: 'For CleanTrack only', preferredCta: 'CleanTrack-only CTA' })

    const blockA = projectAiContextBlock(await buildProjectAiContext(pool, projectA))
    const blockB = projectAiContextBlock(await buildProjectAiContext(pool, projectB))

    assert.ok(blockA.includes('For DriveSet only'))
    assert.ok(!blockA.includes('CleanTrack'), "project A's context must never include project B's name or voice")
    assert.ok(blockB.includes('For CleanTrack only'))
    assert.ok(!blockB.includes('DriveSet'), "project B's context must never include project A's name or voice")
    assert.ok(!blockB.includes('Car detailing'), "project B's context must never include project A's SEO context")
  })
})
