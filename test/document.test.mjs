import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SourceDocument, decodeSource, addressOf, encodeDraft, decodeDraft, storeOrigin, sharedAddress, shareURL, MAX_SOURCE_BYTES } from '../src/document.ts';

test('import, draft persistence and publication snapshot preserve BOM, CRLF and Unicode bytes',async()=>{
  const bytes=Buffer.from('\ufeff# café\r\nx = 1\r\n');
  const doc=new SourceDocument(bytes),saved=decodeDraft(encodeDraft(doc.snapshot()));
  assert.equal(doc.text,bytes.toString('utf8'));
  assert.deepEqual(Buffer.from(saved.bytes),bytes);
  const expected=createHash('sha256').update(bytes).digest('hex')+'_'+bytes.length;
  assert.equal(await addressOf(doc.snapshot().bytes),expected);
});

test('edits and caller mutations cannot change a pending publication snapshot',()=>{
  const input=new Uint8Array([65]);const doc=new SourceDocument(input);
  input[0]=66;
  const snapshot=doc.snapshot();doc.edit('newer');
  assert.deepEqual([...snapshot.bytes],[65]);assert.equal(doc.isCurrent(snapshot),false);
  snapshot.bytes[0]=90;assert.equal(doc.text,'newer');
  const next=doc.snapshot();assert.equal(doc.isCurrent(next),true);
  doc.replace(new TextEncoder().encode('replacement'),'../replacement.sprig');
  assert.equal(doc.isCurrent(next),false);assert.equal(doc.name,'.._replacement.sprig');
});

test('invalid or excessive input cannot replace an intact draft',()=>{
  const doc=new SourceDocument(new TextEncoder().encode('keep'));
  assert.throws(()=>doc.replace(new Uint8Array([255]),'bad'),/UTF-8/);
  assert.throws(()=>doc.edit('é'.repeat(MAX_SOURCE_BYTES)),/256 KiB/);
  assert.equal(doc.text,'keep');assert.equal(doc.revision,0);
  assert.equal(decodeSource(new Uint8Array()),'');
});

test('corrupt and excessive persisted drafts are rejected',()=>{
  for(const raw of ['null','{}','not json',JSON.stringify({v:1,name:'a',bytes:'/w=='}),' '.repeat(360001)])assert.throws(()=>decodeDraft(raw));
});

test('store selection accepts HTTPS and local development, rejects credential and path confusion',()=>{
  assert.equal(storeOrigin('https://blobs.example.com/'),'https://blobs.example.com');
  assert.equal(storeOrigin('http://localhost:8787'),'http://localhost:8787');
  for(const origin of ['http://example.com','javascript:alert(1)','https://user:pass@example.com','https://example.com/b','https://example.com/?token=secret','https://example.com/#token','data:text/plain,hello'])assert.throws(()=>storeOrigin(origin));
});

test('shared paths require canonical digest and length, with the workbench size bound',()=>{
  const digest='a'.repeat(64),address=digest+'_4';
  assert.equal(sharedAddress(new URL('https://sprig.test/')),null);
  assert.equal(sharedAddress(new URL(shareURL('https://sprig.test',address))),address);
  for(const path of ['/w/'+digest+'_04','/w/'+digest.toUpperCase()+'_4','/w/'+digest+'_262145','/w/'+address+'/extra','/w/'+address+'%2f','/other'])assert.throws(()=>sharedAddress(new URL(path,'https://sprig.test')));
});
