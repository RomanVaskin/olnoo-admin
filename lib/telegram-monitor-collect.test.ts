import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { collectTelegramMonitor } from './telegram-monitor-collect.ts'
import { TelegramMonitorError } from './telegram-monitor.ts'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as items from './content-factory-items.ts'
const sourceId='00000000-0000-4000-8000-000000000001',itemId='00000000-0000-4000-8000-000000000002'
const original={version:1,transport:'mtproto',complete:true,peerId:'77',groupedId:null,messageIds:['101'],messages:[{id:'101',text:'Точный текст',entities:[]}]}
function fixture(){
 let state:any={since:'2026-11-01',monitorCursor:'100',monitorPeer:'77'},stored:any=null,snapshot:any=null
 const calls:{sql:string,args:any[]}[]=[]
 const query=async(sql:string,args:any[]=[])=>{
  calls.push({sql,args})
  if(sql==='BEGIN'){snapshot=structuredClone(state);return {rows:[]}}
  if(sql==='ROLLBACK'){state=snapshot;return {rows:[]}}
  if(sql==='COMMIT')return {rows:[]}
  if(sql.startsWith('SELECT automation_runtime'))return {rows:[{automation_runtime:state}]}
  if(sql.startsWith('SELECT id,external_id'))return {rows:stored?[{id:itemId,external_id:'101'}]:[]}
  if(sql.includes('INSERT INTO content_factory_items')){
    assert.equal(args[1],1);assert.equal(args[2],sourceId)
    stored={id:args[0],project_id:args[1],source_id:args[2],external_id:args[3],original_url:args[4],original_text:args[5],original_image_files:JSON.parse(args[8]),original_image_error:args[9],processing_mode:args[10],copy_permission_confirmed:args[11],generated_text:args[12],source_language:args[13],status:args[14],original_telegram:JSON.parse(args[15])};return {rows:[{id:itemId}]}
  }
  if(sql.startsWith('UPDATE content_factory_sources')){state=JSON.parse(args[0]);return {rows:[]}}
  if(sql.startsWith('SELECT * FROM content_factory_items'))return {rows:stored&&args[1]===1?[stored]:[]}
  throw new Error(sql)
 }
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
 const source={id:sourceId,projectId:1,handle:'partner_channel',type:'telegram',processingMode:'copy',copyPermissionConfirmed:true,automation:{mode:'auto_publish',transport:'monitor',dailyLimit:3,accountId:'account',mediaRightsConfirmed:false}} as any
 return {source,pool,calls,state:()=>state,stored:()=>stored}
}

test('monitor commits the checkpoint with exact original and project/source-bound receipt; no AI text rewrite',async()=>{
 const h=fixture()
 const result=await collectTelegramMonitor(h.pool,h.source,async(command,input:any)=>{
  assert.equal(command,'fetch');assert.equal(input.afterId,'100');assert.equal(input.projectId,1);assert.equal(input.sourceId,sourceId)
  return {posts:[{itemId,externalId:'101',url:'https://t.me/partner_channel/101',text:'Точный текст',publishedAt:'2026-11-06',original,error:''}],cursor:'101',peerId:'77'}
 })
 assert.equal(result.created[0].generatedText,'Точный текст');assert.equal(h.state().monitorCursor,'101')
 assert.deepEqual(h.stored().original_telegram,original)
 assert.ok(h.calls.some((c)=>c.sql.includes('ON CONFLICT (source_id,external_id)')))
})

test('disconnect keeps the prior checkpoint; unavailable session and FloodWait never turn into a full copy',async()=>{
 const h=fixture()
 await assert.rejects(()=>collectTelegramMonitor(h.pool,h.source,async()=>{throw new TelegramMonitorError('CONNECTION_FAILED')}),/CONNECTION_FAILED/)
 assert.equal(h.state().monitorCursor,'100');assert.equal(h.stored(),null);assert.equal(h.calls.at(-1)!.sql,'ROLLBACK')
})

test('a partial album is retained as failed without advancing past it',async()=>{
 const h=fixture()
 const result=await collectTelegramMonitor(h.pool,h.source,async()=>({posts:[{itemId,externalId:'101',url:'https://t.me/partner_channel/101',text:'Точный текст',publishedAt:'2026-11-06',original:{...original,complete:false},error:'MEDIA_DOWNLOAD_FAILED'}],cursor:'100',peerId:'77'}))
 assert.equal(result.created[0].status,'failed');assert.equal(h.state().monitorCursor,'100');assert.match(result.error,/MEDIA_DOWNLOAD_FAILED/)
})

test('original attachment endpoint denies missing auth and a foreign project before reading file bytes',async()=>{
 const compiled=ts.transpileModule(readFileSync(new URL('../app/api/content-factory/items/[id]/original-media/[message]/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 let reads=0
 const dependencies:any={'@/lib/db':{pool:{}},'@/lib/crm':{resolveProjectId:async(project:string)=>project==='aurelmar'?1:2},'@/lib/content-factory-items':{getItem:async(_pool:any,project:number)=>project===1?{id:itemId,originalTelegram:{...original,messages:[{id:'101',media:{filename:'file',mimeType:'application/pdf',kind:'document',name:'original.pdf'}}]}}:null},'@/lib/social-telegram-original':{readMonitorMedia:async()=>{reads++;return Buffer.from('file')}}}
 const api:any={};new Function('require','exports',compiled)((name:string)=>dependencies[name],api)
 const params={params:Promise.resolve({id:itemId,message:'101'})}
 assert.equal((await api.GET(new Request('https://admin.test/api?project=aurelmar'),params)).status,403)
 assert.equal((await api.GET(new Request('https://admin.test/api?project=other',{headers:{Authorization:'Basic Zm9vOmJhcg=='}}),params)).status,404)
 assert.equal(reads,0)
 const ranged=await api.GET(new Request('https://admin.test/api?project=aurelmar',{headers:{Authorization:'Basic Zm9vOmJhcg==',Range:'bytes=0-2'}}),params)
 assert.equal(ranged.status,206);assert.equal(await ranged.text(),'fil');assert.equal(ranged.headers.get('content-range'),'bytes 0-2/4')
})

test('scheduler can explicitly baseline at activation, while an ordinary collection-only poll keeps collecting deltas',async()=>{
 const h=fixture();let after:any='unset'
 await collectTelegramMonitor(h.pool,h.source,async(_command,input:any)=>{after=input.afterId;return {posts:[],cursor:'200',peerId:'77'}},true)
 assert.equal(after,null)
 const second=fixture()
 await collectTelegramMonitor(second.pool,second.source,async(_command,input:any)=>{after=input.afterId;return {posts:[],cursor:'100',peerId:'77'}})
 assert.equal(after,'100')
})
