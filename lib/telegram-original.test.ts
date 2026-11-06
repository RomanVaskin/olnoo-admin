import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { trustedTelegramOriginal,type TelegramOriginal } from './telegram-original.ts'
import { loadOriginalPlan,sendOriginalPlan,originalTextChunks,type OriginalPlan } from './social-telegram-original.ts'
const bytes=Buffer.from('unchanged original bytes')
const hash=createHash('sha256').update(bytes).digest('hex')
const file='00000000-0000-4000-8000-000000000001.jpg'
const item='00000000-0000-4000-8000-000000000002'
function original(kinds:string[]=['photo']):TelegramOriginal{
  return {version:1,transport:'mtproto',complete:true,peerId:'77',groupedId:kinds.length>1?'99':null,messageIds:kinds.map((_,i)=>String(101+i)),messages:kinds.map((kind,i)=>({id:String(101+i),text:i===0?'Исходный текст 🪵':'',entities:[],...(kind==='text'?{}:{media:{kind:kind as any,filename:kind==='photo'?file:file.replace('.jpg','.bin'),sha256:hash,bytes:bytes.length,mimeType:kind==='photo'?'image/jpeg':kind==='video'?'video/mp4':'application/pdf',name:'Original'}})}))}
}
const plan=(v:TelegramOriginal)=>loadOriginalPlan(1,item,v,async()=>bytes)

test('full originals bind exact text/entities/ordered IDs; malformed/incomplete/foreign paths are rejected',async()=>{
  const v=original();assert.equal(trustedTelegramOriginal(v,'Исходный текст 🪵'),true)
  assert.equal(trustedTelegramOriginal(v,'Изменённый текст'),false)
  assert.equal(trustedTelegramOriginal({...v,complete:false}),false)
  assert.equal(trustedTelegramOriginal({...v,messages:[null]}),false)
  const bad=original();bad.messages[0].media!.filename='../session';await assert.rejects(()=>plan(bad))
  await assert.rejects(()=>loadOriginalPlan(2,item,v,async()=>Buffer.from('changed')),/integrity/)
})

test('UTF16 emoji formatting offsets survive long-message splitting without losing text or URLs',()=>{
  const text='😀'+ 'а'.repeat(5000)
  const chunks=originalTextChunks(text,[{type:'bold',offset:2,length:5000}])
  assert.equal(chunks.map((c)=>c.text).join(''),text);assert.equal(chunks.length,2)
  assert.equal(chunks[0].entities[0].offset,2);assert.equal(chunks[1].entities[0].offset,0)
  assert.equal(chunks[0].text.endsWith('\ud83d'),false)
})

test('text sends exact entities, whitespace and links; media-only post needs no fake caption',async()=>{
  const v=original(['text']);v.messages[0].text='  Текст https://example.com 🪵  ';v.messages[0].entities=[{type:'bold',offset:2,length:5}]
  const calls:any[]=[]
  const result=await sendOriginalPlan({baseUrl:'https://bot.test',token:'test',chatId:'@target',parts:await plan(v),fetchImpl:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init!.body))});return Response.json({ok:true,result:{message_id:1}})}})
  assert.equal(result.kind,'sent');assert.equal(calls[0].body.text,v.messages[0].text);assert.deepEqual(calls[0].body.entities,v.messages[0].entities)
  const photo=original();photo.messages[0].text=''
  assert.equal((await plan(photo))[0].text,'')
})

for(const kinds of [['photo'],['video'],['document'],['photo','photo','photo','photo'],['photo','video'],['document','document']]){
 test(`publisher preserves ${kinds.join('/')} content and captions`,async()=>{
  const v=original(kinds),calls:any[]=[]
  const result=await sendOriginalPlan({baseUrl:'https://bot.test',token:'test',chatId:'@aurelmar',parts:await plan(v),fetchImpl:async(url,init)=>{
    calls.push({url:String(url),form:init!.body as FormData})
    return Response.json({ok:true,result:kinds.length>1?kinds.map((_,i)=>({message_id:i+1})):{message_id:1}})
  }})
  assert.equal(result.kind,'sent');assert.equal(calls.length,1)
  if(kinds.length>1){const media=JSON.parse(calls[0].form.get('media'));assert.deepEqual(media.map((m:any)=>m.type),kinds);assert.equal(media[0].caption,v.messages[0].text);assert.equal(media[1].caption,undefined)}
  else assert.equal(calls[0].form.get('caption'),v.messages[0].text)
 })
}

test('unsupported mixed albums and missing attachments fail before any Bot API request',async()=>{
 await assert.rejects(()=>plan(original(['photo','document'])),/only permits/)
 await assert.rejects(()=>loadOriginalPlan(1,item,original(),async()=>{throw new Error('missing')}),/missing/)
})

test('long captions and partial/ambiguous responses never allow blind replay',async()=>{
 const v=original(['photo','video']);v.messages[0].text='Т'.repeat(2000)
 let calls=0
 const result=await sendOriginalPlan({baseUrl:'https://bot.test',token:'test',chatId:'@target',parts:await plan(v),fetchImpl:async()=>{calls++;return calls===1?Response.json({ok:true,result:[{message_id:1},{message_id:2}]}):new Response('bad gateway',{status:502})}})
 assert.equal(result.kind,'unknown');assert.equal(calls,2)
 const partial=await sendOriginalPlan({baseUrl:'https://bot.test',token:'test',chatId:'@target',parts:await plan(original(['photo','video'])),fetchImpl:async()=>Response.json({ok:true,result:[{message_id:1}]})})
 assert.equal(partial.kind,'unknown')
 const malformed=await sendOriginalPlan({baseUrl:'https://bot.test',token:'test',chatId:'@target',parts:await plan(original()),fetchImpl:async()=>Response.json({})})
 assert.equal(malformed.kind,'unknown')
})

test('signed grouped_id is preserved and a malformed successful message ID is uncertain',async()=>{
 const v=original(['photo','video']);v.groupedId='-990001';assert.equal(trustedTelegramOriginal(v),true)
 const result=await sendOriginalPlan({baseUrl:'https://bot.test',token:'test',chatId:'@target',parts:await plan(original()),fetchImpl:async()=>Response.json({ok:true,result:{message_id:0}})})
 assert.equal(result.kind,'unknown')
})


test('initial server errors and connection loss remain uncertain, explicit Telegram rejection may fail safely',async()=>{
 for(const fetchImpl of [async()=>new Response('bad gateway',{status:502}),async()=>Response.json({ok:false,description:'server error'},{status:500}),async()=>{throw new Error('connection lost')}]){
  const result=await sendOriginalPlan({baseUrl:'https://bot.test',token:'test',chatId:'@target',parts:await plan(original()),fetchImpl})
  assert.equal(result.kind,'unknown')
 }
 const rejected=await sendOriginalPlan({baseUrl:'https://bot.test',token:'test',chatId:'@target',parts:await plan(original()),fetchImpl:async()=>Response.json({ok:false,description:'Too Many Requests'},{status:429})})
 assert.equal(rejected.kind,'failed')
})
