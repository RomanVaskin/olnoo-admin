import { createHash } from 'node:crypto'
import { lstat,readFile } from 'node:fs/promises'
import path from 'node:path'
import { trustedTelegramOriginal, type TelegramOriginal, type TelegramEntity, type TelegramOriginalMedia } from './telegram-original.ts'
import type { TelegramPhotoSendResult } from './social-telegram-photo.ts'
export type OriginalPart = { text:string;entities:TelegramEntity[];linkPreview?:boolean;media?:TelegramOriginalMedia;bytes?:Buffer }
export type OriginalPlan = OriginalPart[]
/** UTF-16 offsets from Telegram stay UTF-16; split formatting, never surrogate pairs or URL tokens. */
export function originalTextChunks(text:string,entities:TelegramEntity[],limit=4096):{text:string;entities:TelegramEntity[]}[] {
  const chunks=[];let start=0
  while(start<text.length){
    let end=start,count=0
    while(end<text.length&&count<limit){const n=text.codePointAt(end)!;end+=n>0xffff?2:1;count++}
    if(end<text.length){
      for(const e of entities)if(['url','mention','email','hashtag','cashtag','phone_number','custom_emoji'].includes(e.type)&&e.offset<end&&e.offset+e.length>end)end=Math.min(end,e.offset)
      if(end<=start)throw new Error('An indivisible Telegram entity exceeds the message limit.')
    }
    chunks.push({text:text.slice(start,end),entities:entities.flatMap((e)=>{
      const from=Math.max(start,e.offset),to=Math.min(end,e.offset+e.length)
      return to>from?[{...e,offset:from-start,length:to-from}]:[]
    })});start=end
  }
  return chunks
}
export async function loadOriginalPlan(projectId:number,itemId:string,original:unknown,read?:(filename:string)=>Promise<Buffer>):Promise<OriginalPlan>{
  if(!Number.isSafeInteger(projectId)||projectId<1||!/^[0-9a-f-]{36}$/.test(itemId)||!trustedTelegramOriginal(original))throw new Error('Untrusted/incomplete Telegram original.')
  const total=original.messages.reduce((n,m)=>n+(m.media?.bytes??0),0)
  if(total>100*1024*1024)throw new Error('Original attachments exceed the 100 MB per-post limit.')
  const parts:OriginalPart[]=[]
  for(const message of original.messages){
    const part:OriginalPart={text:message.text,entities:message.entities,media:message.media,linkPreview:message.linkPreview}
    // Preflight every attachment/text/entity BEFORE taking the irreversible send claim.
    originalTextChunks(part.text,part.entities)
    if(part.media){
      const filename=part.media.filename
      if(!read){const file=path.join(process.cwd(),'uploads','content-factory','originals',String(projectId),itemId,filename);const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==part.media.bytes)throw new Error('Original file unavailable.');part.bytes=await readFile(file)}
      else part.bytes=await read(filename)
      if(part.bytes.length!==part.media.bytes||createHash('sha256').update(part.bytes).digest('hex')!==part.media.sha256)throw new Error('Original file integrity check failed.')
    }
    parts.push(part)
  }
  const media=parts.filter((p)=>p.media)
  if(parts.length>1&&media.length!==parts.length)throw new Error('Mixed text/attachment group is unsupported.')
  if(media.length>1){const types=new Set(media.map((p)=>p.media!.kind));if(!(Array.from(types).every((v)=>v==='photo'||v==='video')||types.size===1))throw new Error('Telegram only permits photo/video, document-only or audio-only albums.')}
  return parts
}
/** Inside the EXISTING Social publication claim. Any partial delivery remains unknown. */
export async function sendOriginalPlan(input:{baseUrl:string;token:string;chatId:string;parts:OriginalPlan;fetchImpl?:typeof fetch}):Promise<TelegramPhotoSendResult>{
  const request=input.fetchImpl??fetch;let delivered=false,firstId:number|null=null
  const send=async(method:string,body:FormData|Record<string,unknown>,count=1)=>{
    try{
      const form=body instanceof FormData
      const response=await request(`${input.baseUrl}/bot${input.token}/${method}`,{method:'POST',...(form?{body}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)})
      let data:any
      try{data=await response.json()}catch{return {kind:response.ok||response.status>=500||delivered?'unknown':'failed',error:`Telegram API request failed (${response.status}).`} as const}
      if(!response.ok)return {kind:response.status>=500||delivered?'unknown':'failed',error:typeof data?.description==='string'?data.description:`Telegram API request failed (${response.status}).`} as const
      if(data?.ok!==true)return {kind:'unknown',error:'Telegram success response is incomplete.'} as const
      if(count>1&&(!Array.isArray(data.result)||data.result.length!==count||new Set(data.result.map((r:any)=>r.message_id)).size!==count||!data.result.every((r:any)=>Number.isSafeInteger(r.message_id)&&r.message_id>0)))return {kind:'unknown',error:'Telegram did not confirm the complete album.'} as const
      const row=Array.isArray(data.result)?data.result[0]:data.result
      if(!Number.isSafeInteger(row?.message_id)||row.message_id<=0)return {kind:'unknown',error:'Telegram did not confirm message identity.'} as const
      delivered=true;firstId??=row.message_id;return null
    }catch{return {kind:'unknown',error:'Telegram delivery could not be confirmed.'} as const}
  }
  const media=input.parts.filter((p)=>p.media)
  const longCaptions:OriginalPart[]=[]
  if(media.length){
    const form=new FormData();form.set('chat_id',input.chatId)
    const album=media.map((p,index)=>{
      const key=`file${index}`;form.set(key,new Blob([new Uint8Array(p.bytes!)],{type:p.media!.mimeType}),p.media!.name)
      const caption=Array.from(p.text).length<=1024?p.text:''
      if(!caption&&p.text)longCaptions.push(p)
      return {type:p.media!.kind,media:`attach://${key}`,...(caption?{caption,caption_entities:p.entities}:{})}
    })
    let method='sendMediaGroup'
    if(media.length===1){const p=media[0];const kind=p.media!.kind;method={photo:'sendPhoto',video:'sendVideo',audio:'sendAudio',document:'sendDocument'}[kind];form.set(kind,new Blob([new Uint8Array(p.bytes!)],{type:p.media!.mimeType}),p.media!.name);form.delete('file0');if(album[0].caption){form.set('caption',album[0].caption);form.set('caption_entities',JSON.stringify(p.entities))}}
    else form.set('media',JSON.stringify(album))
    const failed=await send(method,form,media.length);if(failed)return failed
  }
  for(const part of media.length?longCaptions:input.parts){for(const chunk of originalTextChunks(part.text,part.entities)){const failed=await send('sendMessage',{chat_id:input.chatId,...chunk,...(part.linkPreview===false?{link_preview_options:{is_disabled:true}}:{})});if(failed)return failed}}
  return firstId!==null?{kind:'sent',messageId:firstId}:{kind:'failed',error:'Original has no supported content.'}
}

export async function readMonitorMedia(projectId:number,itemId:string,media:TelegramOriginalMedia):Promise<Buffer>{
  if(!Number.isSafeInteger(projectId)||projectId<=0||!/^[0-9a-f-]{36}$/.test(itemId)||!/^[0-9a-f-]{36}\.(jpg|png|webp|mp4|bin)$/.test(media.filename)||!/^[-\w.+]+\/[-\w.+]+$/.test(media.mimeType)||!Number.isSafeInteger(media.bytes)||media.bytes<1||media.bytes>50*1024*1024)throw new Error('Invalid original media.')
  const file=path.join(process.cwd(),'uploads','content-factory','originals',String(projectId),itemId,media.filename)
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size!==media.bytes)throw new Error('Original file missing.')
  const bytes=await readFile(file)
  if(createHash('sha256').update(bytes).digest('hex')!==media.sha256)throw new Error('Original file changed.')
  return bytes
}
