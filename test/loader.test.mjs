import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentLoader } from '../src/content-loader.ts';
import { addressOf } from '../src/document.ts';
const signal=()=>new AbortController().signal;
test('loader verifies fetched bytes, uses its captured origin, and returns copies of cached content',async t=>{
  const bytes=new TextEncoder().encode('#!moss/1\n'),address=await addressOf(bytes);let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(url.origin,'https://store.sprig.run');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');return new Response(bytes);});
  const loader=new ContentLoader('https://store.sprig.run',10),first=await loader.load(address,signal());first[0]=0;
  const second=await loader.load(address,signal());assert.deepEqual(second,bytes);assert.equal(calls,1);
});
test('loader rejects corrupt source before it reaches the runtime',async t=>{
  const address=await addressOf(new TextEncoder().encode('right'));
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response('wrong'));
  await assert.rejects(new ContentLoader('https://store.sprig.run',0).load(address,signal()),/digest mismatch/);
  mock.mock.mockImplementation(async()=>new Response('x'));await assert.rejects(new ContentLoader('https://store.sprig.run',0).load(address,signal()),/length mismatch/);
});
test('loader rejects oversized and over-budget graphs before fetching',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('');});
  await assert.rejects(new ContentLoader('https://store.sprig.run',1048576).load('a'.repeat(64)+'_1',signal()),/budget/);
  await assert.rejects(new ContentLoader('https://store.sprig.run',0).load('a'.repeat(64)+'_262145',signal()),/canonical/);
  assert.equal(calls,0);
});
