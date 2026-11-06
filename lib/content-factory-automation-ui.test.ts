import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'
import * as crypto from 'node:crypto'

function nodes(tree: any): any[] { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree,...nodes(tree.props?.children)] }
const text=(tree:any):string=>tree==null||typeof tree==='boolean'?'':typeof tree!=='object'?String(tree):Array.isArray(tree)?tree.map(text).join(''):text(tree.props?.children)
function load(file:string,modules:Record<string,unknown>,tail='') {
  const output=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
  const exports:Record<string,any>={}
  new Function('require','exports',output+tail)((key:string)=>{assert.ok(key in modules,key);return modules[key]},exports)
  return exports
}

test('source editor shows a manual default, no invented target, explicit media rights and saves project-scoped settings', async () => {
  const before=globalThis.fetch
  try {
    const state:any[]=[];let cursor=0
    const react={useEffect(){},useState(initial:any){const slot=cursor++;if(!(slot in state))state[slot]=initial;return [state[slot],(next:any)=>{state[slot]=next}]}}
    const api=load('../components/sections/content-factory-sources-view.tsx',{react,'react/jsx-runtime':jsx,'@/components/primitives':{},'@/components/project-selector':{},'@/components/i18n-provider':{}},'\nexports.Editor=SourceAutomationEditor;')
    const props={source:{id:'source',handle:'partner_channel',type:'telegram',processingMode:'copy'},project:'aurelmar',accounts:[],onSaved:async()=>{}}
    const render=()=>{cursor=0;return api.Editor(props)}
    let tree=render()
    assert.ok(text(tree).includes('Нет подключённых Telegram-каналов'))
    assert.ok(text(tree).includes('HTML-превью не подтверждает полноту'))
    const select=(label:string)=>nodes(render()).find((n)=>n.props?.['aria-label']===`${label} partner_channel`)
    assert.equal(select('Режим публикации').props.value,'manual')
    select('Режим публикации').props.onChange({target:{value:'auto_publish'}})
    assert.equal(nodes(render()).find((n)=>n.type==='button').props.disabled,true)
    select('Канал назначения').props.onChange({target:{value:'connected-account'}})
    select('Лимит в сутки').props.onChange({target:{value:'3'}})
    let sent:any=null
    globalThis.fetch=async(url,init)=>{sent={url:String(url),body:JSON.parse(String(init!.body)),method:init!.method};return Response.json({})}
    await nodes(render()).find((n)=>n.type==='button').props.onClick()
    assert.equal(sent.url,'/api/content-factory/sources/source?project=aurelmar')
    assert.equal(sent.method,'PATCH');assert.equal(sent.body.automation.mode,'auto_publish')
    assert.equal(sent.body.automation.mediaRightsConfirmed,false)
    assert.equal(sent.body.automation.accountId,'connected-account')
  } finally {globalThis.fetch=before}
})

test('scheduler HTTP trigger refuses absent/short/wrong tokens and passes server-only opt-in to the real sweep boundary', async () => {
  const env=process.env as Record<string,string|undefined>
  const prior=env.CONTENT_FACTORY_SCHEDULER_TOKEN, optIn=env.CONTENT_FACTORY_AUTOMATION_ENABLED
  let calls=0,enabled:any
  const api=load('../app/api/content-factory-scheduler/run/route.ts',{
    'node:crypto':crypto,'next/server':{NextResponse:{json:Response.json}},'@/lib/db':{pool:{}},
    '@/lib/content-factory-publish':{publishContentFactoryItem:async()=>{}},
    '@/lib/content-factory-scheduler':{runContentFactorySourceSweep:async(_pool:unknown,deps:any)=>{calls++;enabled=deps.enabled;return []}},
  })
  const request=(token='')=>new Request('http://localhost/api/content-factory-scheduler/run',{method:'POST',headers:{'X-Scheduler-Token':token}})
  try {
    delete env.CONTENT_FACTORY_SCHEDULER_TOKEN;assert.equal((await api.POST(request())).status,503)
    env.CONTENT_FACTORY_SCHEDULER_TOKEN='short';assert.equal((await api.POST(request('short'))).status,503)
    env.CONTENT_FACTORY_SCHEDULER_TOKEN='x'.repeat(40)
    assert.equal((await api.POST(request('wrong'))).status,401);assert.equal(calls,0)
    env.CONTENT_FACTORY_AUTOMATION_ENABLED='false';assert.equal((await api.POST(request('x'.repeat(40)))).status,200);assert.equal(enabled,false)
    env.CONTENT_FACTORY_AUTOMATION_ENABLED='true';assert.equal((await api.POST(request('x'.repeat(40)))).status,200);assert.equal(enabled,true)
  } finally {
    if(prior===undefined)delete env.CONTENT_FACTORY_SCHEDULER_TOKEN;else env.CONTENT_FACTORY_SCHEDULER_TOKEN=prior
    if(optIn===undefined)delete env.CONTENT_FACTORY_AUTOMATION_ENABLED;else env.CONTENT_FACTORY_AUTOMATION_ENABLED=optIn
  }
})

test('automatic preparation executes the existing generator/parser and independent review boundary; source link is reviewed and malformed review never approves', async () => {
  let generated=0,reviewed=0,fail=false,finished:any, saved:any
  const claim={id:'item',projectId:1,originalText:'Оригинал',originalUrl:'https://t.me/channel_name/101',generatedTitle:'Новый заголовок',generatedText:'Новый материал\n\nИсточник: https://t.me/channel_name/101',imageFilename:'',aiReview:{claimId:'claim'}}
  const api=load('./content-factory-automation.ts',{
    './content-factory-items.ts':{setGeneratedContent:async(_p:any,_project:any,_id:any,content:any)=>{saved=content;return claim},claimAiReview:async()=>claim,finishAiReview:async(_p:any,_project:any,_id:any,_snapshot:any,review:any)=>{finished=review;return claim}},
    './content-factory-generate.ts':{generateContentFactoryArticle:async()=>{generated++;return {title:'Новый заголовок',body:'Новый материал',needsReview:false,reviewReason:''}}},
    './content-factory-review.ts':{reviewContentFactoryItem:async(_pool:any,item:any)=>{reviewed++;assert.match(item.generatedText,/Источник: https:\/\/t.me\/channel_name\/101/);if(fail)throw new Error('invalid JSON');return {status:'passed'}}},
    './content-factory-languages.ts':{},
  })
  const pool={query:async()=>({rowCount:1})}
  await api.prepareAutomationItem(pool,claim)
  assert.equal(generated,1);assert.equal(reviewed,1);assert.equal(finished.status,'passed');assert.equal(saved.status,'needs_review')
  fail=true;await assert.rejects(()=>api.prepareAutomationItem(pool,claim),/AI-проверка/);assert.equal(finished.status,'error');assert.equal(finished.passed,false)
})
