import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { runContentFactorySourceSweep, type AutomationDeps } from './content-factory-scheduler.ts'
import { needsAutomationEditor, claimTelegramOrigin } from './content-factory-automation.ts'
import { DEFAULT_SOURCE_AUTOMATION, parseSourceAutomation, sourceAutomationAccess } from './content-factory-source-policy.ts'
import { createSource, updateSource } from './content-factory-sources.ts'
import { getItem, type ContentFactoryItem } from './content-factory-items.ts'

function harness(mode = 'auto_publish', processing = 'ai') {
  let now = new Date('2026-11-06T10:00:00Z'), locked = false, generationError = false, channelError = false, sendError = '', sendErrorText = 'send failed', critical = false, duplicates = false
  let hold: Promise<void> | null = null
  const source: Record<string, any> = { id: 'source', project_id: 1, project_slug: 'aurelmar', type: 'telegram', handle: 'partner_channel', enabled: true, processing_mode: processing, copy_permission_confirmed: processing === 'copy',
    automation: { mode, accountId: 'account', dailyLimit: 3, mediaRightsConfirmed: true }, automation_revision: 'rev1', automation_runtime: {}, last_checked_at: null }
  const items: Record<string, any>[] = [], social: { status: string }[] = []
  const calls = { check: 0, verify: 0, prepare: 0, approve: 0, publish: 0, unlock: 0 }
  function add(id: number, overrides: Record<string, unknown> = {}) {
    const row = { id: String(id), project_id: 1, source_id: 'source', external_id: String(id), original_url: `https://t.me/partner_channel/${id}`,
      original_text: `Публикация номер ${id}`, original_image_urls: '', original_image_files: [], original_image_error: '', origin_kind: 'source',
      processing_mode: processing, copy_permission_confirmed: processing === 'copy', generated_title: '', generated_text: processing === 'copy' ? 'Скопированный текст' : '',
      source_language: 'ru', status: processing === 'copy' ? 'needs_review' : 'new', review_reason: '', automation: {} as Record<string, any>, created_at: now.toISOString(), ...overrides }
    items.push(row); return row
  }
  const query = async (sql: string, args: any[] = []) => {
    if (sql.includes('p.slug AS project_slug')) return { rows: [{ ...source }] }
    if (sql.includes('SELECT * FROM content_factory_sources')) return { rows: source.enabled ? [source] : [] }
    if (sql.includes('SELECT id FROM content_factory_sources')) return { rows: duplicates ? [{ id: 'duplicate' }] : [] }
    if (sql.startsWith('UPDATE content_factory_sources')) { source.automation_runtime = JSON.parse(args[0]); return { rows: [], rowCount: 1 } }
    if (sql.includes('SET automation = $1::jsonb') && sql.includes('external_id')) {
      for (const item of items) if (BigInt(item.external_id) > BigInt(args[3]) && new Date(item.created_at) >= new Date(args[4]) && !item.automation.status) item.automation = JSON.parse(args[0])
      return { rows: [] }
    }
    if (sql.startsWith('SELECT id, automation FROM')) return { rows: items.filter((i) => i.project_id === args[0] && i.source_id === args[1] && i.automation.revision === args[2] && ['pending','failed','processing','publishing','send_retry'].includes(i.automation.status)).slice(0,1) }
    if (sql.startsWith('SELECT * FROM content_factory_items')) return { rows: items.filter((i) => i.id === args[0] && i.project_id === args[1]) }
    if (sql.startsWith('UPDATE content_factory_items SET automation = $1')) { const item = items.find((i) => i.id === args[1]); if (item) item.automation = JSON.parse(args[0]); return { rows: [] } }
    if (sql.startsWith('UPDATE content_factory_items SET ru_account_id')) return { rows: [] }
    if (sql.includes('COUNT(DISTINCT p.id)')) return { rows: [{ count: Number(source.existingPublishedCount ?? 0) }] }
    if (sql.includes('SELECT status FROM social_publications')) return { rows: social }
    if (sql.includes('jsonb_set(automation')) { for (const i of items) if (i.automation.status === 'processing' && !i.generated_text) { i.automation.status = 'failed'; i.status = 'failed' } return { rows: [] } }
    if (sql.startsWith('UPDATE content_factory_items\n') || sql.includes('SET status = $1')) { const row = items.find((i) => i.id === args[3]); if (row) row.status = args[0]; return { rows: row ? [row] : [] } }
    throw new Error(`Unexpected SQL: ${sql}`)
  }
  const pool = { query, connect: async () => ({
    query: async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) { if (locked) return { rows: [{ locked: false }] }; locked = true; return { rows: [{ locked: true }] } }
      if (sql.includes('pg_advisory_unlock')) { locked = false; calls.unlock++; return { rows: [] } }
      throw new Error(sql)
    }, release() {},
  }) } as unknown as Pool
  const deps: AutomationDeps = { enabled: true, now: () => now,
    check: async () => { calls.check++; source.last_checked_at = now.toISOString(); return { created: [], error: '', observedMaxId: String(Math.max(0,...items.map((i) => Number(i.external_id)))) } },
    verify: async () => { calls.verify++; if (channelError) throw new Error('channel forbidden'); return { id: 'account', username: '@aurelmar' } },
    prepare: async (_pool, item) => {
      calls.prepare++; if (hold) await hold
      if (generationError) throw new Error('router error')
      const row = items.find((i) => i.id === item.id)!
      row.generated_title = 'Заголовок'; row.generated_text = critical ? 'Обещаем доходность 30%' : 'Самостоятельный материал о городской среде.'
      row.status = 'needs_review'; row.source_language = 'ru'
      row.ai_review = { status: 'passed', passed: true, risk: 'low', quality: { passed: true, issues: [], recommendations: [] }, reviewedTitle: row.generated_title, reviewedText: row.generated_text, reviewedImageFilename: '' }
      return (await getItem(pool, 1, item.id))!
    },
    approve: async (_pool, _source, item) => { calls.approve++; return item },
    publish: async (_project, _id, _language) => { calls.publish++; if (sendError) { social.splice(0, social.length, { status: sendError }); return { error: sendErrorText, status: 503 } } social.push({ status: 'published' }); return { item: (await getItem(pool,1,_id))! } },
  }
  return { source, items, calls, deps, pool, add, advance(ms = 660_000) { now = new Date(now.getTime() + ms) }, day() { now = new Date(now.getTime() + 86400_000) },
    run: () => runContentFactorySourceSweep(pool, deps), generationFails() { generationError = true }, inaccessible() { channelError = true }, sendFails(status: string, text = 'send failed') { sendError = status; sendErrorText = text }, risky() { critical = true }, duplicate() { duplicates = true }, hold(promise: Promise<void>) { hold = promise } }
}
async function armed(mode = 'auto_publish', processing = 'ai') {
  const h = harness(mode, processing); h.add(100); await h.run(); h.advance(); return h
}

test('source policy defaults manual, rejects invalid limits/modes/no target/unknown runtime controls and foreign Origin', () => {
  assert.deepEqual(parseSourceAutomation(undefined), DEFAULT_SOURCE_AUTOMATION)
  for (const value of [{ ...DEFAULT_SOURCE_AUTOMATION, dailyLimit: 0 }, { ...DEFAULT_SOURCE_AUTOMATION, dailyLimit: 21 }, { ...DEFAULT_SOURCE_AUTOMATION, mode: 'auto_publish' }, { ...DEFAULT_SOURCE_AUTOMATION, paused: false }]) assert.throws(() => parseSourceAutomation(value))
  const req = (headers: Record<string,string>) => new Request('http://localhost/api', { headers })
  assert.equal(sourceAutomationAccess(req({ Origin: 'https://admin.olnoo.com', Authorization: 'Basic Zm9vOmJhcg==' })), true)
  assert.equal(sourceAutomationAccess(req({ Origin: 'https://evil.test', Authorization: 'Basic Zm9vOmJhcg==' })), false)
  assert.equal(sourceAutomationAccess(req({ Origin: 'https://admin.olnoo.com' })), false)
})

test('manual and server kill switch collect only; ten-minute interval is enforced', async () => {
  for (const manual of [true,false]) {
    const h = harness(manual ? 'manual' : 'auto_publish'); if (!manual) h.deps.enabled = false
    h.add(1); await h.run(); await h.run()
    assert.equal(h.calls.check, 1); assert.equal(h.calls.prepare, 0); assert.equal(h.calls.publish, 0)
  }
})

test('first snapshot never prepares archive; only a new message is prepared/published once, with persistent snapshot and lock release', async () => {
  const h = await armed(); assert.equal(h.calls.prepare,0); assert.equal(h.source.automation_runtime.cursor,'100')
  h.add(101); await h.run(); h.advance(); await h.run()
  assert.equal(h.calls.prepare,1); assert.equal(h.calls.approve,1); assert.equal(h.calls.publish,1)
  assert.equal(h.items[0].automation.status, undefined); assert.equal(h.items[1].automation.status,'published')
  assert.equal(h.calls.unlock,3); assert.equal(h.source.automation_runtime.sendUsed,1)
})

test('approval mode and uncertain investment assertions always go to human review, without approval/send', async () => {
  for (const mode of ['auto_review','auto_publish']) {
    const h = await armed(mode); if (mode === 'auto_publish') h.risky()
    h.add(101); await h.run(); assert.equal(h.calls.prepare,1); assert.equal(h.calls.approve,0); assert.equal(h.calls.publish,0)
    assert.equal(h.items[1].automation.status,'review')
  }
})

test('partner text/photo copy is prepared without paid AI, but HTML completeness is never forged into manual approval', async () => {
  const h = await armed('auto_publish','copy'); h.add(101, { original_image_urls: 'https://cdn/a.jpg,https://cdn/b.jpg', original_image_files: ['a.jpg'] })
  await h.run(); assert.equal(h.calls.prepare,0); assert.equal(h.calls.approve,0); assert.equal(h.calls.publish,0)
  assert.match(h.items[1].automation.error,/HTML-превью/); assert.equal(h.items[1].automation.status,'review')
})

test('daily three-send cap and paid-attempt cap survive repeated sweeps; next day resumes a prepared item', async () => {
  const h = await armed()
  for (let id=101;id<=104;id++) { h.add(id); await h.run(); h.advance() }
  assert.equal(h.calls.publish,3); assert.equal(h.calls.prepare,3)
  assert.equal(h.source.automation_runtime.operation,'ai_limit')
  h.day(); await h.run(); assert.equal(h.calls.publish,4)
})

test('inaccessible channel and active source duplicates pause before paid calls', async () => {
  for (const duplicate of [true,false]) {
    const h = await armed(); h.add(101); if (duplicate) h.duplicate(); else h.inaccessible()
    await h.run(); assert.equal(h.calls.prepare,0); assert.equal(h.calls.publish,0); assert.equal(h.source.automation_runtime.paused,true)
  }
})

test('Router failures have bounded attempts and durable budget, without publishing partial content', async () => {
  const h = await armed(); h.add(101); h.generationFails()
  for (let i=0;i<4;i++) { await h.run(); h.advance() }
  assert.equal(h.calls.prepare,2); assert.equal(h.calls.publish,0)
  assert.equal(h.source.automation_runtime.aiUsed,2); assert.equal(h.items[1].automation.status,'review')
})

test('confirmed and unknown Telegram errors stop automation; repeated tick never duplicates send', async () => {
  for (const status of ['failed','publishing']) {
    const h = await armed(); h.add(101); h.sendFails(status); await h.run(); h.advance(); await h.run()
    assert.equal(h.calls.publish,1); assert.equal(h.source.automation_runtime.paused,true)
    assert.equal(h.items[1].automation.status,status === 'publishing' ? 'uncertain' : 'review')
  }
})

test('restart with an in-flight send fails closed; interrupted AI work requires manual recovery without another charge', async () => {
  for (const status of ['publishing','processing']) {
    const h = await armed(); const item=h.add(101); item.automation={ ...h.source.automation, revision:'rev1', status, attempts:1 }
    await h.run(); assert.equal(h.calls.prepare,0); assert.equal(h.calls.publish,0)
    assert.equal(item.automation.status,status === 'publishing' ? 'uncertain' : 'review')
  }
})

test('overlapping sweeps share one physical-session advisory lock and publish only once', async () => {
  const h=await armed(); h.add(101)
  let release=()=>{}; const pending=new Promise<void>((resolve)=>{release=resolve}); h.hold(pending)
  const first=h.run(); await new Promise((resolve)=>setImmediate(resolve)); await h.run()
  assert.equal(h.calls.prepare,1); release(); await first; assert.equal(h.calls.publish,1)
})

test('persistent origin claim normalizes channel/post and catches the unique index; own materials are not affected', async () => {
  const writes: any[][]=[]
  const pool={ query: async (_sql: string,args: any[])=>{writes.push(args);if(writes.length>1)throw Object.assign(new Error('duplicate'),{code:'23505'});return {rowCount:1} } } as unknown as Pool
  const item={id:'item',projectId:1,originKind:'source',originalUrl:'https://t.me/Partner_Channel/00123'} as ContentFactoryItem
  assert.equal(await claimTelegramOrigin(pool,item),true); assert.equal(writes[0][0],'partner_channel/123')
  assert.equal(await claimTelegramOrigin(pool,{...item,id:'duplicate'}),false)
  assert.equal(await claimTelegramOrigin(pool,{...item,originKind:'own'}),true); assert.equal(writes.length,2)
})

test('generator/reviewer gates reject high/medium risk, failed quality, stale review and review reasons without asserting fact verification', () => {
  const item={generatedText:'Текст', generatedTitle:'Заголовок',imageFilename:'',reviewReason:'',aiReview:{status:'passed',passed:true,risk:'low',quality:{passed:true},reviewedTitle:'Заголовок',reviewedText:'Текст',reviewedImageFilename:''}} as ContentFactoryItem
  assert.equal(needsAutomationEditor(item),false)
  for(const change of [{reviewReason:'Проверьте цифры'},{aiReview:{...item.aiReview!,risk:'medium'}},{aiReview:{...item.aiReview!,risk:'high'}},{generatedText:'Изменённый текст'},{aiReview:{...item.aiReview!,quality:{passed:false}}}])assert.equal(needsAutomationEditor({...item,...change} as ContentFactoryItem),true)
})

test('create canonicalizes three Telegram formats, refuses existing duplicates atomically, keeps sources in other projects independent', async () => {
  const rows: Record<string,any>[]=[]; const locks: string[]=[]
  const pool = { query: async (sql: string, args: any[]=[]) => {
    if(sql.includes('pg_advisory_xact_lock')){locks.push(sql);return {rows:[]}}
    if(sql.includes('SELECT id, enabled FROM content_factory_sources'))return {rows:rows.filter((r)=>r.project_id===args[0]&&r.handle===args[1]&&r.id!==args[2])}
    if(sql.includes('INSERT INTO content_factory_sources')){const row={id:args[0],project_id:args[1],type:args[2],handle:args[3],processing_mode:args[4],copy_permission_confirmed:args[5],automation:JSON.parse(args[6]),automation_revision:args[7]};rows.push(row);return {rows:[row]}}
    throw new Error(sql)
  }} as unknown as Pool
  const first = await createSource(pool,1,{type:'telegram',handle:'@Partner_Channel'})
  assert.equal(first.handle,'partner_channel');assert.equal(first.automation!.mode,'manual')
  for(const handle of ['partner_channel','https://t.me/Partner_Channel'])await assert.rejects(()=>createSource(pool,1,{type:'telegram',handle}),/уже есть/)
  await createSource(pool,2,{type:'telegram',handle:'partner_channel'})
  assert.equal(rows.length,2);assert.equal(locks.length,4)
})

test('foreign target account is rejected and settings cannot inject runtime controls', async () => {
  const pool={query:async (sql:string)=>({rows:sql.includes('SELECT id, enabled')?[]:[]})} as unknown as Pool
  await assert.rejects(()=>createSource(pool,1,{type:'telegram',handle:'channel_name',automation:{...DEFAULT_SOURCE_AUTOMATION,mode:'auto_publish',accountId:'foreign'}}),/этого проекта/)
  await assert.rejects(()=>createSource(pool,1,{type:'telegram',handle:'channel_name',automation:{...DEFAULT_SOURCE_AUTOMATION,aiUsed:0}}),/настройки|Выберите/)
})

test('source update keeps daily budget across revision resets and never accepts another project source', async () => {
  const row={id:'source',project_id:1,type:'telegram',handle:'channel_name',enabled:true,processing_mode:'ai',automation:DEFAULT_SOURCE_AUTOMATION,automation_revision:'old',automation_runtime:{aiUsed:3,sendUsed:3,paused:true}}
  let written=false
  const pool={query:async (sql:string,args:any[]=[])=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[]}
    if(sql.startsWith('SELECT * FROM content_factory_sources'))return {rows:args[1]===1?[row]:[]}
    if(sql.includes('SELECT id, enabled'))return {rows:[]}
    if(sql.startsWith('UPDATE content_factory_sources')){
      assert.match(sql,/automation_runtime - ARRAY/); assert.equal(args[7],true)
      assert.equal(sql.includes("'aiUsed'"),false);assert.equal(sql.includes("'sendUsed'"),false)
      written=true;return {rows:[{...row,automation:JSON.parse(args[6])}]}
    }
    throw new Error(sql)
  }} as unknown as Pool
  assert.equal(await updateSource(pool,2,'source',{automation:DEFAULT_SOURCE_AUTOMATION}),null)
  assert.equal(written,false)
  await updateSource(pool,1,'source',{automation:DEFAULT_SOURCE_AUTOMATION});assert.equal(written,true)
})

test('one bounded retry of an explicit Telegram 429 rejection reuses the item; no further AI call or third send', async () => {
  const h=await armed(); h.add(101); h.sendFails('failed','Too Many Requests: retry after 10')
  await h.run(); assert.equal(h.items[1].automation.status,'send_retry')
  h.advance();await h.run();assert.equal(h.calls.publish,2);assert.equal(h.calls.prepare,1);assert.equal(h.calls.approve,1)
  h.advance();await h.run();assert.equal(h.calls.publish,2);assert.equal(h.source.automation_runtime.paused,true)
})

test('calendar timer jitter does not turn ten-minute windows into twenty-minute polling', async () => {
  const h=harness();h.add(100);await h.run()
  h.source.automation_runtime.lastStartedAt='2026-11-06T10:00:01Z'
  h.advance(600_000);h.add(101);await h.run()
  assert.equal(h.calls.check,2);assert.equal(h.calls.publish,1)
})

test('RSS finder transaction clients are never connected again or nested inside BEGIN', async () => {
  const sql: string[]=[]
  const client={release(){},connect:async()=>{throw new Error('PoolClient must not reconnect')},query:async(query:string,args:any[]=[])=>{
    sql.push(query)
    if(query.startsWith('INSERT'))return {rows:[{id:args[0],project_id:args[1],type:args[2],handle:args[3],automation:JSON.parse(args[6])}]}
    return {rows:[]}
  }} as unknown as Pool
  const source=await createSource(client,1,{type:'rss',handle:'https://example.com/feed'})
  assert.equal(source.type,'rss');assert.equal(sql.includes('BEGIN'),false);assert.equal(sql.includes('COMMIT'),false)
})

test('manual approval/target choice is not overwritten by automatic source approval', async () => {
  const h=await armed();h.add(101,{ru_approved_at:'2026-11-06T10:10:00Z',ru_account_id:'human-selected-channel'})
  await h.run();assert.equal(h.calls.prepare,0);assert.equal(h.calls.approve,0);assert.equal(h.calls.publish,0)
  assert.equal(h.items[1].ru_account_id,'human-selected-channel')
})

test('already delivered source publications count against the day cap even when a previous-day request finished after midnight', async () => {
  const h=await armed();h.add(101);h.source.existingPublishedCount=3
  await h.run();assert.equal(h.calls.publish,0);assert.equal(h.source.automation_runtime.operation,'daily_limit')
  assert.equal(h.source.automation_runtime.sendUsed,3)
})
