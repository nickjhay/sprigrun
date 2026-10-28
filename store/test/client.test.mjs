import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadSource, shareSource, shareSourceBytes, solveChallenge } from '../examples/client.ts';
const digest=b=>createHash('sha256').update(b).digest('hex');
const address=b=>`${digest(b)}_${Buffer.byteLength(b)}`;
const ticket=a=>({protocol:'blob-store-upload-v1',id:'1'.repeat(64),address:a,expires_at_ms:Date.now()+600000,target:'f'.repeat(64)});

test('browser client verifies exact bytes before decoding, including BOM and CRLF',async t=>{
  const source='\ufefffrom world.v4 import *\r\n', bytes=Buffer.from(source);
  t.mock.method(globalThis,'fetch',async()=>new Response(bytes));
  const result=await loadSource('https://example.test',address(bytes));
  assert.equal(result.source,source); assert.deepEqual(Buffer.from(result.bytes),bytes);
});

test('browser client verifies length and hash independently of supplied headers',async t=>{
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response('wrong'));
  await assert.rejects(loadSource('https://example.test',address('right')),/digest mismatch/);
  mock.mock.mockImplementation(async()=>new Response('x'));
  await assert.rejects(loadSource('https://example.test',address('right')),/length mismatch/);
  let cancelled=false;
  mock.mock.mockImplementation(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(6));},cancel(){cancelled=true;}})));
  await assert.rejects(loadSource('https://example.test',address('right')),/client size limit/);
  assert.equal(cancelled,true);
});

test('browser upload solves the ticket without changing source and checks full acknowledgement',async t=>{
  const source='\ufeffx = 1\r\n', a=address(source);
  let uploaded, c;
  const mock=t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');
    if(options.method==='POST'){c=ticket(a);assert.equal(url.pathname,`/challenge/b/${a}`);return Response.json(c);}
    assert.equal(options.method,'PUT'); assert.equal(options.headers['Blob-Ticket'],c.id);
    assert.match(options.headers['Blob-Nonce'],/^[0-9a-f]{16}$/);
    uploaded=Buffer.from(options.body);
    return Response.json({address:a,digest:digest(uploaded),bytes:uploaded.length});
  });
  assert.equal(await shareSource('https://example.test',source),a);
  assert.deepEqual(uploaded,Buffer.from(source));
  mock.mock.mockImplementation(async(_,o)=>o.method==='POST'?Response.json(ticket(a)):Response.json({address:a,digest:'0'.repeat(64),bytes:Buffer.byteLength(source)}));
  await assert.rejects(shareSource('https://example.test',source),/identity mismatch/);
});

test('already-written is idempotent for the helper without a second upload',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({error:'already_written'},{status:409});});
  assert.equal(await shareSource('https://example.test','x'),address('x')); assert.equal(calls,1);
});

test('untrusted challenge parameters, excessive work and cancellation are bounded',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json(ticket(address('other'))));
  await assert.rejects(shareSource('https://example.test','x'),/Challenge address/);
  await assert.rejects(solveChallenge({...ticket(address('x')),target:'0'.repeat(64)},{maxTrials:1}),/No solution/);
  await assert.rejects(solveChallenge({...ticket(address('x')),expires_at_ms:1}),/expired/);
  await assert.rejects(solveChallenge(ticket(address('x')),{signal:AbortSignal.abort()}));
  await assert.rejects(solveChallenge(ticket(address('x')),{maxTrials:Infinity}),/Invalid solver/);
});

test('mutable caller buffers are copied before asynchronous upload work',async t=>{
  const bytes=new Uint8Array([65]), a=address(bytes);
  t.mock.method(globalThis,'fetch',async(_,options)=>{
    if(options.method==='POST'){bytes[0]=66;return Response.json(ticket(a));}
    assert.deepEqual(options.body,new Uint8Array([65]));
    return Response.json({address:a,digest:digest('A'),bytes:1});
  });
  assert.equal(await shareSourceBytes('https://example.test',bytes),a);
});

test('browser helper exposes friendly server guidance as text',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({message:'Request a fresh challenge and solve it locally.'},{status:409}));
  await assert.rejects(shareSource('https://example.test','x'),/Upload failed \(409\): Request a fresh challenge/);
});
