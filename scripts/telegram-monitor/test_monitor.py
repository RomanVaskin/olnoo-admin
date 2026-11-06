import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace as NS, ModuleType
from unittest.mock import patch
import monitor

SOURCE='00000000-0000-4000-8000-000000000001'
def message(i,group=None,kind=None):
    doc=NS(size=3,mime_type=kind,attributes=[]) if kind and kind!='photo' else None
    if kind=='video/mp4': doc.attributes=[type('DocumentAttributeVideo',(),{})()]
    return NS(id=i,grouped_id=group,message=f'Текст {i} 🪵',entities=[],date=datetime.now(timezone.utc)-timedelta(seconds=10),photo=kind=='photo',document=doc,media=None,action=None,noforwards=False)
class Client:
    def __init__(self,messages):self.messages=messages;self.downloads=[];self.fail=None
    async def get_entity(self,_):return NS(id=77,broadcast=True,noforwards=False,left=False)
    async def get_messages(self,_,limit=None,ids=None):
        return [m for m in self.messages if m.id in ids] if ids is not None else sorted(self.messages,key=lambda m:m.id,reverse=True)[:limit]
    async def iter_messages(self,_,min_id,max_id,reverse,limit):
        for m in sorted(self.messages,key=lambda m:m.id):
            if min_id<m.id<max_id:yield m
    async def download_media(self,m,file,progress_callback):
        self.downloads.append(m.id)
        if self.fail==m.id:raise RuntimeError('fixture connection failure')
        Path(file).write_bytes(b'raw-original');progress_callback(12,12)

class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.old=os.getcwd();self.tmp=tempfile.TemporaryDirectory();os.chdir(self.tmp.name)
        channels=ModuleType('telethon.tl.functions.channels');channels.JoinChannelRequest=lambda p:p
        self.modules=patch.dict('sys.modules',{'telethon':ModuleType('telethon'),'telethon.tl':ModuleType('telethon.tl'),'telethon.tl.functions':ModuleType('telethon.tl.functions'),'telethon.tl.functions.channels':channels});self.modules.start()
    def tearDown(self):self.modules.stop();os.chdir(self.old);self.tmp.cleanup()
    def fetch(self,client,after='100'):
        return asyncio.run(monitor.fetch_posts(client,{'handle':'partner_channel','projectId':1,'sourceId':SOURCE,'afterId':after,'peerId':'77'}))
    def test_baseline_does_not_download_archive(self):
        c=Client([message(100,kind='photo')]);r=self.fetch(c,None)
        self.assertEqual(r['cursor'],'100');self.assertEqual(r['posts'],[]);self.assertEqual(c.downloads,[])
    def test_grouped_photos_order_captions_retry_and_immutable_files(self):
        c=Client([message(i,9,'photo') for i in range(101,105)]);c.fail=103
        first=self.fetch(c);self.assertFalse(first['posts'][0]['original']['complete']);self.assertEqual(first['cursor'],'100')
        self.assertEqual([m['id'] for m in first['posts'][0]['original']['messages']],['101','102'])
        c.fail=None;second=self.fetch(c);self.assertEqual(second['cursor'],'104')
        post=second['posts'][0];self.assertTrue(post['original']['complete'])
        self.assertEqual(post['original']['messageIds'],['101','102','103','104'])
        self.assertEqual(post['text'],'\n\n'.join(m.message for m in c.messages))
        self.assertEqual(c.downloads.count(101),1)
        for p in Path('uploads').rglob('*.jpg'):self.assertEqual(p.read_bytes(),b'raw-original')
    def test_group_crossing_initial_baseline_is_skipped_as_a_whole(self):
        c=Client([message(i,9,'photo') for i in range(101,105)])
        self.assertEqual(self.fetch(c,'103')['posts'],[])
    def test_text_video_document_and_mixed_visual_album(self):
        c=Client([message(101),message(102,8,'photo'),message(103,8,'video/mp4'),message(104,kind='application/pdf')])
        r=self.fetch(c);self.assertEqual(len(r['posts']),3)
        self.assertEqual([m['media']['kind'] for m in r['posts'][1]['original']['messages']],['photo','video'])
        self.assertEqual(r['posts'][2]['original']['messages'][0]['media']['kind'],'document')
    def test_utf16_entities_and_unsupported_entities(self):
        entity=type('MessageEntityBold',(),{'offset':3,'length':5})()
        self.assertEqual(monitor.entities([entity]),[{'type':'bold','offset':3,'length':5}])
        with self.assertRaises(monitor.MonitorError):monitor.entities([type('MessageEntityMentionName',(),{})()])
    def test_size_and_session_permissions_fail_closed(self):
        m=message(101,kind='application/pdf');m.document.size=monitor.MAX_FILE+1
        with self.assertRaises(monitor.MonitorError):monitor.media_info(m)
        secret=Path('secrets');secret.mkdir(mode=0o755);secret.chmod(0o755)
        with patch.dict(os.environ,{'TELEGRAM_MONITOR_DIR':str(secret)}):
            with self.assertRaises(monitor.MonitorError):monitor.secret_dir()
            secret.chmod(0o700);self.assertEqual(monitor.secret_dir(),secret)
    def test_scope_changes_item_ids(self):
        self.assertNotEqual(monitor.item_uuid(1,SOURCE,77,101),monitor.item_uuid(2,SOURCE,77,101))
        with self.assertRaises(monitor.MonitorError):
            asyncio.run(monitor.fetch_posts(Client([]),{'handle':'bad/../host','projectId':1,'sourceId':SOURCE}))
    def test_new_client_reuses_completed_files_after_a_failed_album(self):
        old=Client([message(i,9,'photo') for i in range(101,105)]);old.fail=103
        self.fetch(old)
        fresh=Client(old.messages);result=self.fetch(fresh)
        self.assertTrue(result['posts'][0]['original']['complete'])
        self.assertEqual(fresh.downloads,[103,104])
    def test_user_joins_public_channel_without_admin_requests(self):
        class Joining(Client):
            joined=False
            async def get_entity(self,_):return NS(id=77,broadcast=True,noforwards=False,left=True)
            async def __call__(self,_):self.joined=True
        c=Joining([message(100)]);self.fetch(c,None);self.assertTrue(c.joined)

if __name__=='__main__':unittest.main()
