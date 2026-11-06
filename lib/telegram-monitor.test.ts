import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

test('bridge decodes split UTF8 without corrupting text/entities and passes only Monitor credentials to child',async()=>{
 const env=process.env as Record<string,string|undefined>,beforeId=env.TELEGRAM_MONITOR_API_ID,beforeHash=env.TELEGRAM_MONITOR_API_HASH
 env.TELEGRAM_MONITOR_API_ID='12345';env.TELEGRAM_MONITOR_API_HASH='a'.repeat(32)
 try{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stdin:new PassThrough(),kill(){}})
  let options:any,input=''
  child.stdin.on('data',(b)=>{input+=b.toString()})
  const compiled=ts.transpileModule(readFileSync(new URL('./telegram-monitor.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText
  const api:any={}
  new Function('require','exports',compiled)((name:string)=>name==='node:path'?path:name==='node:child_process'?{spawn:(_cmd:any,_args:any,opts:any)=>{options=opts;return child}}:null,api)
  const result=api.runTelegramMonitor('fetch',{projectId:1,handle:'partner_channel'})
  const payload=Buffer.from(JSON.stringify({text:'Исходный текст 🪵 без изменений'}))
  const emoji=payload.indexOf(Buffer.from('🪵'))
  child.stdout.write(payload.subarray(0,emoji+1));child.stdout.write(payload.subarray(emoji+1));child.emit('close',0)
  assert.equal((await result).text,'Исходный текст 🪵 без изменений')
  for(const forbidden of ['DATABASE_URL','OLNOO_ROUTER_TOKEN','TELEGRAM_BOT_TOKEN'])assert.equal(forbidden in options.env,false)
  assert.deepEqual(JSON.parse(input),{projectId:1,handle:'partner_channel'})
 } finally{if(beforeId===undefined)delete env.TELEGRAM_MONITOR_API_ID;else env.TELEGRAM_MONITOR_API_ID=beforeId;if(beforeHash===undefined)delete env.TELEGRAM_MONITOR_API_HASH;else env.TELEGRAM_MONITOR_API_HASH=beforeHash}
})
