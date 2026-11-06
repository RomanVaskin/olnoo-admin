#!/usr/bin/env python3
"""Short-lived MTProto reader. No bot sends, daemon, SQLite or background queue."""
import asyncio
import fcntl
import getpass
import hashlib
import json
import logging
import os
import re
import stat
import sys
import time
import uuid
import warnings
from datetime import datetime, timezone
from pathlib import Path

logging.disable(logging.CRITICAL)
MAX_FILE = 50 * 1024 * 1024
ENTITY_TYPES = {'Bold':'bold','Italic':'italic','Underline':'underline','Strike':'strikethrough',
    'Spoiler':'spoiler','Code':'code','Pre':'pre','TextUrl':'text_link','Url':'url','Mention':'mention',
    'Hashtag':'hashtag','Cashtag':'cashtag','Email':'email','Phone':'phone_number',
    'Blockquote':'blockquote','CustomEmoji':'custom_emoji'}
class MonitorError(Exception):
    def __init__(self, code): self.code = code

def entities(values):
    result = []
    for e in values or []:
        name = type(e).__name__.removeprefix('MessageEntity')
        if name not in ENTITY_TYPES: raise MonitorError('UNSUPPORTED_ENTITY')
        row = {'type': ENTITY_TYPES[name], 'offset': e.offset, 'length': e.length}
        if name == 'Pre': row['language'] = e.language or ''
        if name == 'TextUrl': row['url'] = e.url
        if name == 'CustomEmoji': row['custom_emoji_id'] = str(e.document_id)
        if name == 'Blockquote' and getattr(e, 'collapsed', False): row['type'] = 'expandable_blockquote'
        result.append(row)
    return result

def media_info(message):
    if type(getattr(message,'media',None)).__name__ == 'MessageMediaWebPage': return None
    if getattr(message, 'photo', None): return {'kind':'photo','mimeType':'image/jpeg','extension':'jpg','name':'photo.jpg'}
    doc = getattr(message, 'document', None)
    if not doc:
        if getattr(message, 'media', None): raise MonitorError('UNSUPPORTED_ATTACHMENT')
        return None
    attributes = doc.attributes or []
    names = {type(a).__name__ for a in attributes}
    if names & {'DocumentAttributeSticker','DocumentAttributeCustomEmoji','DocumentAttributeAnimated'}: raise MonitorError('UNSUPPORTED_ATTACHMENT')
    if any(getattr(a, 'voice', False) or getattr(a, 'round_message', False) for a in attributes): raise MonitorError('UNSUPPORTED_ATTACHMENT')
    if doc.size > MAX_FILE: raise MonitorError('FILE_TOO_LARGE')
    mime = doc.mime_type or 'application/octet-stream'
    name = next((a.file_name for a in attributes if hasattr(a, 'file_name')), 'attachment')
    kind = 'video' if mime == 'video/mp4' and 'DocumentAttributeVideo' in names else 'audio' if mime in ('audio/mpeg','audio/mp4') and 'DocumentAttributeAudio' in names else 'document'
    return {'kind':kind,'mimeType':mime,'extension':'mp4' if kind=='video' else 'bin','name':Path(name).name[:200]}

def item_uuid(project, source, peer, external):
    raw = hashlib.sha256(f'{project}:{source}:{peer}:{external}'.encode()).digest()[:16]
    return str(uuid.UUID(bytes=raw, version=4))

def secret_dir(create=False):
    path = Path(os.environ.get('TELEGRAM_MONITOR_DIR','/opt/olnoo/secrets/telegram-monitor'))
    if create: path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if not path.exists(): raise MonitorError('AUTHORIZATION_REQUIRED')
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077: raise MonitorError('UNSAFE_SESSION_PERMISSIONS')
    return path

def atomic_session(path, value):
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW, 0o600)
    os.fchmod(fd,0o600)
    with os.fdopen(fd,'w') as stream:
        stream.write(value); stream.flush(); os.fsync(stream.fileno())
    os.replace(tmp, path)

async def save_media(client, message, directory, info):
    filename = str(uuid.uuid5(uuid.NAMESPACE_URL, f'{message.id}:{getattr(getattr(message, "photo", None) or getattr(message, "document", None), "id", 0)}')) + '.' + info['extension']
    target = directory / filename
    # Successfully downloaded bytes are immutable and reused after partial batch failures.
    meta = directory / (filename + '.sha256')
    if target.exists() and meta.exists() and not target.is_symlink() and not meta.is_symlink():
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest == meta.read_text().strip(): return {**info,'filename':filename,'sha256':digest,'bytes':target.stat().st_size}
        raise MonitorError('SAVED_MEDIA_CHANGED')
    tmp = directory / (filename + '.part')
    if tmp.is_symlink(): raise MonitorError('UNSAFE_MEDIA_PATH')
    def progress(received, _total):
        if received > (10*1024*1024 if info['kind']=='photo' else MAX_FILE): raise MonitorError('FILE_TOO_LARGE')
    await client.download_media(message, file=str(tmp), progress_callback=progress)
    if not tmp.exists() or not tmp.stat().st_size or tmp.stat().st_size > (10*1024*1024 if info['kind']=='photo' else MAX_FILE): raise MonitorError('MEDIA_DOWNLOAD_FAILED')
    os.chmod(tmp,0o600)
    digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
    meta.write_text(digest);os.chmod(meta,0o600)
    os.replace(tmp,target)
    return {**info,'filename':filename,'sha256':digest,'bytes':target.stat().st_size}

async def fetch_posts(client, data):
    from telethon.tl.functions.channels import JoinChannelRequest
    handle = data.get('handle','')
    if not re.fullmatch('[A-Za-z0-9_]{5,32}',handle): raise MonitorError('INVALID_CHANNEL')
    project, source = data.get('projectId'), data.get('sourceId','')
    if not isinstance(project,int) or project <= 0 or not re.fullmatch('[0-9a-f-]{36}',source): raise MonitorError('INVALID_SCOPE')
    peer = await client.get_entity(handle)
    if not getattr(peer,'broadcast',False): raise MonitorError('CHANNEL_REQUIRED')
    if getattr(peer,'noforwards',False): raise MonitorError('PROTECTED_CONTENT')
    if getattr(peer,'left',False): await client(JoinChannelRequest(peer))
    head_messages = await client.get_messages(peer,limit=1)
    head = head_messages[0].id if head_messages else 0
    after = data.get('afterId')
    if after is None: return {'posts':[],'cursor':str(head),'peerId':str(peer.id),'baseline':True}
    if data.get('peerId') not in (None,str(peer.id)): raise MonitorError('CHANNEL_ID_CHANGED')
    after = int(after)
    messages = [m async for m in client.iter_messages(peer,min_id=after,max_id=head+1,reverse=True,limit=201)]
    groups=[]
    for message in messages:
        key = str(message.grouped_id) if getattr(message,'grouped_id',None) else 'single:'+str(message.id)
        if groups and groups[-1][0] == key: groups[-1][1].append(message)
        else: groups.append((key,[message]))
    posts=[];cursor=after
    known=data.get('knownItems',{})
    root = Path.cwd()/'uploads'/'content-factory'/'originals'/str(project)
    for index,(_key,group) in enumerate(groups):
        if index >= min(20,max(1,int(data.get('maxPosts',20)))): break
        if len(messages)==201 and index==len(groups)-1: break  # never cut a group at page/batch boundary
        first=group[0]
        if getattr(first,'action',None): cursor=max(m.id for m in group);continue
        if first.grouped_id:
            # Hydrate both sides of the history-page boundary. Telegram media groups have <=10 messages.
            neighbours=await client.get_messages(peer,ids=list(range(max(1,first.id-10),max(m.id for m in group)+11)))
            group=sorted([m for m in neighbours if getattr(m,'grouped_id',None)==first.grouped_id],key=lambda m:m.id)
            if not group or len(group)>10: raise MonitorError('INCOMPLETE_ALBUM')
            if min(m.id for m in group)<=after:
                cursor=max(cursor,max(m.id for m in group));continue  # an album began before the baseline
            if max(m.id for m in group)>head or (datetime.now(timezone.utc)-max(m.date for m in group)).total_seconds()<2: break
        first=group[0]
        ids=[m.id for m in group]
        existing=next((str(i) for i in ids if str(i) in known),None)
        external=existing or str(min(ids))
        item_id=known[existing] if existing else item_uuid(project,source,peer.id,external)
        if not re.fullmatch('[0-9a-f-]{36}',item_id): raise MonitorError('INVALID_SCOPE')
        directory=root/item_id
        directory.mkdir(parents=True,mode=0o700,exist_ok=True)
        if directory.is_symlink(): raise MonitorError('UNSAFE_MEDIA_PATH')
        rows=[];error=''
        for message in group:
            row={'id':str(message.id),'text':message.message or '', 'entities':[], 'linkPreview':type(getattr(message,'media',None)).__name__=='MessageMediaWebPage'}
            try:
                if getattr(message,'noforwards',False): raise MonitorError('PROTECTED_CONTENT')
                row['entities']=entities(message.entities)
                info=media_info(message)
                if info: row['media']=await save_media(client,message,directory,info)
                rows.append(row)
            except MonitorError as exc: error=exc.code;break
            except Exception as exc:
                if type(exc).__name__=='FloodWaitError': raise
                error='MEDIA_DOWNLOAD_FAILED';break
        original={'version':1,'transport':'mtproto','complete':not error,'peerId':str(peer.id),'groupedId':str(first.grouped_id) if first.grouped_id else None,'messageIds':[str(i) for i in ids],'messages':rows}
        posts.append({'itemId':item_id,'externalId':external,'url':f'https://t.me/{handle}/{external}',
            'text':'\n\n'.join(m.message for m in group if m.message), 'publishedAt':first.date.isoformat(), 'original':original,'error':error})
        if error: break  # retain files, but never move checkpoint past a failed logical post
        cursor=max(cursor,max(ids))
    return {'posts':posts,'cursor':str(cursor),'peerId':str(peer.id),'baseline':False}

async def main(command):
    from telethon import TelegramClient, errors
    from telethon.sessions import StringSession
    if command=='auth':
        if not sys.stdin.isatty(): raise MonitorError('AUTH_REQUIRES_TTY')
        warnings.simplefilter('error',getpass.GetPassWarning)
    api_id=os.environ.get('TELEGRAM_MONITOR_API_ID','');api_hash=os.environ.get('TELEGRAM_MONITOR_API_HASH','')
    if not api_id.isdigit() or not re.fullmatch('[0-9a-fA-F]{32}',api_hash): raise MonitorError('NOT_CONFIGURED')
    directory=secret_dir(command=='auth'); session_file=directory/'session'
    fd=os.open(directory/'lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: raise MonitorError('BUSY')
    try:
        saved=''
        if session_file.exists():
            info=session_file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise MonitorError('UNSAFE_SESSION_PERMISSIONS')
            saved=session_file.read_text().strip()
        client=TelegramClient(StringSession(saved),int(api_id),api_hash,timeout=15,connection_retries=2,request_retries=1,retry_delay=1,flood_sleep_threshold=0,auto_reconnect=True,device_model='OLNOO Monitor',app_version='1.0')
        try:
            await client.connect()
            if command=='auth' and not await client.is_user_authorized():
                phone=getpass.getpass('Telegram phone (hidden): ')
                sent=await client.send_code_request(phone)
                try: await client.sign_in(phone=phone,code=getpass.getpass('Telegram code (hidden): '),phone_code_hash=sent.phone_code_hash)
                except errors.SessionPasswordNeededError: await client.sign_in(password=getpass.getpass('Telegram 2FA password (hidden): '))
            if not await client.is_user_authorized(): raise MonitorError('AUTHORIZATION_REQUIRED')
            me=await client.get_me()
            if not me or me.bot: raise MonitorError('USER_ACCOUNT_REQUIRED')
            result=await fetch_posts(client,json.loads(sys.stdin.read(65537))) if command=='fetch' else {'status':'connected'}
            atomic_session(session_file,client.session.save())
            return result
        finally: await client.disconnect()
    except errors.FloodWaitError as exc: return {'error':'FLOOD_WAIT','retryAfterSeconds':int(exc.seconds)}
    finally: os.close(fd)

if __name__=='__main__':
    os.umask(0o077)
    try:
        if len(sys.argv)!=2 or sys.argv[1] not in ('auth','status','fetch'): raise MonitorError('INVALID_COMMAND')
        result=asyncio.run(main(sys.argv[1]));print(json.dumps(result,ensure_ascii=False))
        if result.get('error'): sys.exit(1)
    except MonitorError as exc: print(json.dumps({'error':exc.code}));sys.exit(1)
    except ImportError: print(json.dumps({'error':'TELETHON_NOT_INSTALLED'}));sys.exit(1)
    except Exception: print(json.dumps({'error':'CONNECTION_FAILED'}));sys.exit(1)
