import type { ContentFactoryItem } from './content-factory-items.ts'
export type TelegramEntity = { type: string; offset: number; length: number; url?: string; language?: string; custom_emoji_id?: string }
export type TelegramOriginalMedia = { kind:'photo'|'video'|'document'|'audio'; filename:string; mimeType:string; sha256:string; bytes:number; name:string }
export type TelegramOriginal = { version:1; transport:'mtproto'; complete:boolean; peerId:string; groupedId:string|null; messageIds:string[]; messages:{id:string;text:string;entities:TelegramEntity[];linkPreview?:boolean;media?:TelegramOriginalMedia}[] }
const entityTypes = new Set(['bold','italic','underline','strikethrough','spoiler','code','pre','text_link','url','mention','hashtag','cashtag','email','phone_number','blockquote','expandable_blockquote','custom_emoji'])
export function validEntities(text:string,values:unknown): values is TelegramEntity[] {
  return Array.isArray(values) && values.length<=1000 && values.every((e)=>e && entityTypes.has(e.type) && Number.isSafeInteger(e.offset) && Number.isSafeInteger(e.length) && e.offset>=0 && e.length>0 && e.offset+e.length<=text.length && (e.type!=='text_link'||typeof e.url==='string') && (e.type!=='custom_emoji'||/^\d+$/.test(e.custom_emoji_id)))
}
export function originalText(original:TelegramOriginal):string { return original.messages.map((m)=>m.text).filter((v)=>v!=='').join('\n\n') }
export function trustedTelegramOriginal(value:unknown,text?:string): value is TelegramOriginal {
  if(!value||typeof value!=='object')return false
  const v=value as TelegramOriginal
  if(v.version!==1||v.transport!=='mtproto'||v.complete!==true||typeof v.peerId!=='string'||!/^\d+$/.test(v.peerId)||(v.groupedId!==null&&(typeof v.groupedId!=='string'||!/^[-]?\d+$/.test(v.groupedId)))||!Array.isArray(v.messages)||v.messages.length<1||v.messages.length>10||!Array.isArray(v.messageIds)||new Set(v.messageIds).size!==v.messages.length||v.messageIds.length!==v.messages.length)return false
  if(!v.messages.every((m,i)=>m && typeof m==='object' && m.id===v.messageIds[i]&&/^\d+$/.test(m.id)&&typeof m.text==='string'&&validEntities(m.text,m.entities)&&(!m.media||(['photo','video','document','audio'].includes(m.media.kind)&&/^[0-9a-f-]{36}\.(jpg|png|webp|mp4|bin)$/.test(m.media.filename)&&/^[0-9a-f]{64}$/.test(m.media.sha256)&&Number.isSafeInteger(m.media.bytes)&&m.media.bytes>0&&m.media.bytes<=50*1024*1024&&typeof m.media.mimeType==='string'&&typeof m.media.name==='string'))))return false
  return (text===undefined||text===originalText(v)) && v.messages.some((m)=>m.text.length||m.media)
}
export function isTrustedCopy(item:ContentFactoryItem):boolean { return item.processingMode==='copy'&&trustedTelegramOriginal(item.originalTelegram,item.originalText)&&item.generatedText===item.originalText&&!item.originalImageError&&!item.imageFilename }
