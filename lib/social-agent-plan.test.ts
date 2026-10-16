import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSocialAgentPlanPrompt, parseSocialAgentPlan, SocialAgentPlanError, SOCIAL_AGENT_PLAN_SYSTEM_PROMPT } from './social-agent-plan.ts'

test('requirement: the planning system prompt never hardcodes OLNOO (or any other fixed brand) as the subject', () => {
  assert.ok(!SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.includes('OLNOO'))
})

test('requirement: the planning prompt demands a complete, ready-to-publish post, never a description of one', () => {
  assert.ok(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.toLowerCase().includes('complete, publish-ready'))
  assert.ok(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.includes('This post is about'), 'must name the banned announcement framing explicitly')
  assert.ok(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.includes("We'll tell you about"))
  assert.ok(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.includes('Here we\'ll focus on'))
  assert.ok(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.includes('We need to write about'))
})

test('requirement: the planning prompt never again asks for a "shared" summary body that gets adapted later — the regression that caused the original defect', () => {
  // "shared content every channel later adapts from" was the exact earlier wording that nudged the
  // model toward an outline/brief instead of a finished post — this guards against it coming back.
  assert.ok(!SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.toLowerCase().includes('shared content'))
  assert.ok(!SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.toLowerCase().includes('adapts from'))
})

test('requirement: the planning prompt asks for distinct, non-repetitive posts when more than one is planned', () => {
  assert.ok(/distinct|genuinely different/i.test(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT))
})

test('requirement: the planning prompt still preserves the task language rule and Brand Profile rule', () => {
  assert.ok(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.includes('SAME language as TASK'))
  assert.ok(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.includes('Brand Profile'))
  assert.ok(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT.includes('CONSTRAINTS'))
})

test('requirement: practical examples are allowed only as explicitly marked hypotheticals, never invented as real', () => {
  assert.ok(/hypothetical/i.test(SOCIAL_AGENT_PLAN_SYSTEM_PROMPT))
})

test('buildSocialAgentPlanPrompt includes the task, project context, and available channels', () => {
  const prompt = buildSocialAgentPlanPrompt({
    task: 'Подготовь три поста на неделю о полировке автомобилей для DriveSet',
    projectContext: 'DriveSet (driveset.example)',
    availableChannels: ['telegram', 'vk'],
  })
  assert.ok(prompt.includes('Подготовь три поста на неделю о полировке автомобилей для DriveSet'))
  assert.ok(prompt.includes('DriveSet (driveset.example)'))
  assert.ok(prompt.includes('telegram, vk'))
})

test('buildSocialAgentPlanPrompt states explicitly when no channels are connected, never omits the line', () => {
  const prompt = buildSocialAgentPlanPrompt({ task: 'x', projectContext: '', availableChannels: [] })
  assert.ok(prompt.includes('(none connected)'))
})

test('parseSocialAgentPlan: a valid JSON array of posts is parsed as-is', () => {
  const raw = JSON.stringify([
    { topic: 'Why ceramic coating matters', body: 'A short explainer on ceramic coating benefits.', channels: ['telegram', 'vk'] },
    { topic: 'Before/after polish results', body: 'Showcasing a recent polish job.', channels: ['telegram'] },
  ])
  const items = parseSocialAgentPlan(raw, ['telegram', 'vk'])
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], { topic: 'Why ceramic coating matters', body: 'A short explainer on ceramic coating benefits.', channels: ['telegram', 'vk'] })
})

test('parseSocialAgentPlan: strips a markdown code fence before parsing', () => {
  const raw = '```json\n' + JSON.stringify([{ topic: 'A', body: 'B', channels: ['telegram'] }]) + '\n```'
  const items = parseSocialAgentPlan(raw, ['telegram'])
  assert.equal(items.length, 1)
})

test('parseSocialAgentPlan: a channel outside AVAILABLE CHANNELS is dropped from that post, never invented', () => {
  const raw = JSON.stringify([{ topic: 'A', body: 'B', channels: ['telegram', 'instagram'] }])
  const items = parseSocialAgentPlan(raw, ['telegram']) // instagram is not connected
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].channels, ['telegram'])
})

test('parseSocialAgentPlan: a post left with zero usable channels after filtering is dropped entirely', () => {
  const raw = JSON.stringify([
    { topic: 'Keep me', body: 'B', channels: ['telegram'] },
    { topic: 'Drop me', body: 'B', channels: ['instagram'] }, // not connected — zero channels survive
  ])
  const items = parseSocialAgentPlan(raw, ['telegram'])
  assert.equal(items.length, 1)
  assert.equal(items[0].topic, 'Keep me')
})

test('parseSocialAgentPlan: an entry missing topic or body is dropped, never defaulted to empty strings', () => {
  const raw = JSON.stringify([
    { topic: '', body: 'B', channels: ['telegram'] },
    { topic: 'A', body: '', channels: ['telegram'] },
    { topic: 'A', body: 'B', channels: ['telegram'] },
  ])
  const items = parseSocialAgentPlan(raw, ['telegram'])
  assert.equal(items.length, 1)
})

test('requirement: parseSocialAgentPlan drops a post whose body is a meta-description instead of real content, keeping the others', () => {
  const raw = JSON.stringify([
    { topic: 'Bad one', body: 'Пост о том, как ИИ используется в бизнесе.', channels: ['telegram'] },
    { topic: 'Also bad', body: "This post is about our new winter detailing package.", channels: ['telegram'] },
    { topic: 'Good one', body: 'Зимой дорожная соль разрушает лак — керамическое покрытие защищает кузов всю зиму.', channels: ['telegram'] },
  ])
  const items = parseSocialAgentPlan(raw, ['telegram'])
  assert.equal(items.length, 1)
  assert.equal(items[0].topic, 'Good one')
})

test('requirement: parseSocialAgentPlan throws when EVERY post is a meta-description — never silently accepts a plan of only bad posts', () => {
  const raw = JSON.stringify([
    { topic: 'A', body: 'Пост о том, как мы работаем.', channels: ['telegram'] },
    { topic: 'B', body: "We'll tell you about our services.", channels: ['telegram'] },
  ])
  assert.throws(() => parseSocialAgentPlan(raw, ['telegram']), SocialAgentPlanError)
})

test('parseSocialAgentPlan: capped at 10 items even if the model returns more', () => {
  const raw = JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ topic: `Post ${i}`, body: 'B', channels: ['telegram'] })))
  const items = parseSocialAgentPlan(raw, ['telegram'])
  assert.equal(items.length, 10)
})

test('parseSocialAgentPlan: a non-array JSON response throws SocialAgentPlanError', () => {
  assert.throws(() => parseSocialAgentPlan(JSON.stringify({ topic: 'A', body: 'B', channels: ['telegram'] }), ['telegram']), SocialAgentPlanError)
})

test('parseSocialAgentPlan: not valid JSON at all throws SocialAgentPlanError', () => {
  assert.throws(() => parseSocialAgentPlan('not json at all', ['telegram']), SocialAgentPlanError)
})

test('parseSocialAgentPlan: an array where every entry is unusable throws SocialAgentPlanError', () => {
  const raw = JSON.stringify([{ topic: '', body: '', channels: [] }])
  assert.throws(() => parseSocialAgentPlan(raw, ['telegram']), SocialAgentPlanError)
})

test('parseSocialAgentPlan: a stray object before/after the array (model commentary) is recovered via the [ ... ] fallback', () => {
  const raw = `Here is the plan:\n${JSON.stringify([{ topic: 'A', body: 'B', channels: ['telegram'] }])}\nLet me know if you want changes.`
  const items = parseSocialAgentPlan(raw, ['telegram'])
  assert.equal(items.length, 1)
})
