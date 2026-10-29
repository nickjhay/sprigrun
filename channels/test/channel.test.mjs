import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startLocalChannels} from '../scripts/local.mjs';
import {keys,createChannel,appendText,readChannel,challenge,digest,randomHex,solve,validateBatch,serviceOrigin} from '../src/client.ts';
import {parseCursor,proofText,workTarget} from '../src/protocol.ts';
const enc=new TextEncoder();
async function fixture(t,vars={}){const s=await startLocalChannels({vars:{REQUEST_BURST:'1000',CHALLENGE_BURST:'1000',...vars}});t.after(()=>s.close());return s;}
async function prepared(s,k,epoch,text,id=randomHex()){
  const bytes=typeof text==='string'?enc.encode(text):text;
  const p=await challenge(s.origin,k.secret,{operation:'append',epoch,message_id:id,digest:await digest(bytes),bytes:bytes.length});
  return {body:bytes,method:'POST',headers:{Authorization:`Bearer ${k.secret}`,'Content-Type':'text/plain;charset=utf-8','Channel-Epoch':epoch,'Channel-Message-Id':id,'Channel-Ticket':p.ticket.id,'Channel-Nonce':p.nonce}};
}
async function code(response,status,error){assert.equal(response.status,status,await response.clone().text());if(error)assert.equal((await response.json()).error,error);}
async function socket(origin,address,cursor){
  const ws=new WebSocket(origin.replace('http','ws')+'/channel/'+address+(cursor?'?after='+cursor:''));
  const queue=[],waiters=[];let closed=false;
  ws.addEventListener('message',e=>{const m=validateBatch(JSON.parse(e.data));if(waiters.length)waiters.shift()(m);else queue.push(m);});
  ws.addEventListener('close',()=>{closed=true;});
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  return {ws,queue,get closed(){return closed;},ack:b=>ws.send(JSON.stringify({ack:b.receipt})),next:()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{const id=setTimeout(()=>reject(new Error('Timed out waiting for a batch')),4000);waiters.push(v=>{clearTimeout(id);resolve(v);});})};
}

test('wire encodings, key hash, cursor and client validation',async()=>{
  const k=await keys('00'.repeat(32));assert.equal(k.address,'66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
  assert.equal(workTarget(0,0,0),'f'.repeat(64));assert.equal(workTarget(8,0,0),'00'+'f'.repeat(62));
  assert.equal(parseCursor('a'.repeat(32)+'_01'),null);assert.equal(parseCursor('a'.repeat(32)+'_9007199254740992'),null);
  assert.throws(()=>serviceOrigin('https://example.org/path'));assert.throws(()=>serviceOrigin('http://example.org'));
  assert.throws(()=>validateBatch({}));
});

test('public creation, exact UTF-8, role checks, proof binding and single use', {timeout:30000},async t=>{
  const s=await fixture(t,{CREATE_POW_BITS:'8',APPEND_POW_BITS:'8',POW_PER_BYTE:'1'}),k=await keys(),other=await keys();
  await code(await fetch(s.origin+'/channel/'+k.address),404);
  assert.match(await(await fetch(s.origin+'/')).text(),/channels 0\n/);
  await code(await fetch(s.origin+'/challenge/channel/'+k.address,{method:'POST',headers:{Authorization:'Bearer '+other.secret},body:'{}'}),403);
  const created=await createChannel(s.origin,k.secret),text='\ufeffHello, moss 🌿\r\n\u0000';
  const req=await prepared(s,k,created.epoch,text);
  await code(await fetch(s.origin+'/channel/'+k.address,req),201);
  const b=await readChannel(s.origin,k.address);assert.equal(b.messages[0].text,text);assert.equal(b.messages[0].seq,1);
  const duplicate=await fetch(s.origin+'/channel/'+k.address,req);await code(duplicate,200);assert.equal((await duplicate.json()).duplicate,true);
  await code(await fetch(s.origin+'/channel/'+k.address,{...req,body:'different'}),409,'message_id_conflict');
  await code(await fetch(s.origin+'/channel/'+k.address,{...req,headers:{...req.headers,'Channel-Message-Id':randomHex()}}),409,'ticket_spent_or_expired');
  const invalid=await prepared(s,k,created.epoch,new Uint8Array([255]));
  await code(await fetch(s.origin+'/channel/'+k.address,invalid),422,'invalid_utf8');
  await code(await fetch(s.origin+'/channel/'+k.address,invalid),409,'ticket_spent_or_expired');
  const mismatch=await prepared(s,k,created.epoch,'original');
  await code(await fetch(s.origin+'/channel/'+k.address,{...mismatch,body:'changed'}),422,'message_does_not_match_challenge');
  const p=await challenge(s.origin,k.secret,{operation:'append',epoch:created.epoch,message_id:randomHex(),digest:await digest(enc.encode('x')),bytes:1});
  let bad='0000000000000000';while(await digest(enc.encode(proofText(p.ticket,bad)))<=p.ticket.target)bad=(BigInt('0x'+bad)+1n).toString(16).padStart(16,'0');
  await code(await fetch(s.origin+'/channel/'+k.address,{method:'POST',headers:{Authorization:'Bearer '+k.secret,'Channel-Epoch':created.epoch,'Channel-Message-Id':p.ticket.message_id,'Channel-Ticket':p.ticket.id,'Channel-Nonce':bad},body:'x'}),422,'proof_not_solved');
  const wrongEpoch={...req,headers:{...req.headers,'Channel-Epoch':randomHex()}};
  await code(await fetch(s.origin+'/channel/'+k.address,wrongEpoch),409,'channel_replaced');
  assert.equal((await fetch(s.origin+'/channel/'+k.address)).headers.get('Cache-Control'),'no-store');
  assert.equal((await fetch(s.origin+'/channel/'+k.address)).headers.get('Access-Control-Allow-Origin'),'*');
});

test('concurrent appends, rolling bytes and count, gaps and bounded responses', {timeout:30000},async t=>{
  const s=await fixture(t,{CHANNEL_MESSAGES:'2',CHANNEL_BYTES:'8192'}),k=await keys(),c=await createChannel(s.origin,k.secret);
  const results=await Promise.all(Array.from({length:6},(_,i)=>appendText(s.origin,k.secret,c.epoch,String(i))));
  assert.deepEqual(results.map(r=>parseCursor(r.cursor).seq).sort((a,b)=>a-b),[1,2,3,4,5,6]);
  let b=await readChannel(s.origin,k.address,c.epoch+'_0');assert.equal(b.messages.length,2);assert.equal(b.earliest,5);assert.equal(b.gap,true);
  await appendText(s.origin,k.secret,c.epoch,'x'.repeat(5000));await appendText(s.origin,k.secret,c.epoch,'y'.repeat(5000));
  b=await readChannel(s.origin,k.address);assert.equal(b.messages.length,1);assert.equal(b.messages[0].text[0],'y');
  await appendText(s.origin,k.secret,c.epoch,'\u0000'.repeat(8192));
  const response=await fetch(s.origin+'/channel/'+k.address);assert.ok((await response.arrayBuffer()).byteLength<=65536);
  await code(await fetch(s.origin+'/channel/'+k.address+'?after='+c.epoch+'_9999'),409,'cursor_ahead');
  await code(await fetch(s.origin+'/channel/'+k.address+'?after='+c.epoch+'_01'),400,'invalid_cursor');
});

test('WebSocket catch-up, live order, ACK backpressure and a gap after slow reading', {timeout:30000},async t=>{
  const s=await fixture(t,{CHANNEL_MESSAGES:'2'}),k=await keys(),c=await createChannel(s.origin,k.secret);
  await appendText(s.origin,k.secret,c.epoch,'first');
  const sub=await socket(s.origin,k.address,c.epoch+'_0');t.after(()=>sub.ws.close());
  const first=await sub.next();assert.equal(first.messages[0].text,'first');
  for(let i=0;i<4;i++)await appendText(s.origin,k.secret,c.epoch,'later '+i);
  assert.equal(sub.queue.length,0); // exactly one outstanding frame
  sub.ack(first);const catchup=await sub.next();assert.equal(catchup.gap,true);assert.deepEqual(catchup.messages.map(m=>m.seq),[4,5]);
  sub.ack(catchup);await appendText(s.origin,k.secret,c.epoch,'live');const live=await sub.next();assert.equal(live.messages[0].text,'live');sub.ack(live);
  const second=await socket(s.origin,k.address,live.cursor);t.after(()=>second.ws.close());
  const empty=await second.next();assert.equal(empty.messages.length,0);second.ack(empty);
  await appendText(s.origin,k.secret,c.epoch,'both');assert.equal((await second.next()).messages[0].text,'both');assert.equal((await sub.next()).messages[0].text,'both');
});

test('initial WebSocket batch budgets escaped text and receipt fields before continuing on ACK', {timeout:15000},async t=>{
  const s=await fixture(t),k=await keys(),c=await createChannel(s.origin,k.secret);
  for(let i=0;i<3;i++)await appendText(s.origin,k.secret,c.epoch,'\u0000'.repeat(4096));
  const sub=await socket(s.origin,k.address);t.after(()=>sub.ws.close());
  const first=await sub.next();
  assert.ok(enc.encode(JSON.stringify(first)).byteLength<=65536);
  assert.match(first.receipt,/^[0-9a-f]{32}$/);
  assert.ok(first.subscription_expires_at_ms<=first.expires_at_ms);
  assert.deepEqual(first.messages.map(m=>m.seq),[1,2]);assert.equal(first.has_more,true);assert.equal(first.gap,false);
  sub.ack(first);const next=await sub.next();
  assert.deepEqual(next.messages.map(m=>m.seq),[3]);assert.equal(next.has_more,false);sub.ack(next);
});

test('age expiry, channel recreation, quota bounds and restart persistence', {timeout:30000},async t=>{
  const temp=await mkdtemp(join(tmpdir(),'sprig-channels-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const vars={MAX_CHANNELS:'1',MAX_TICKETS:'1',MESSAGE_AGE_SECONDS:'1',CHANNEL_LIFETIME_SECONDS:'3',REQUEST_BURST:'1000'};
  let s=await startLocalChannels({persistPath:join(temp,'state'),vars});t.after(()=>s.close());
  const k=await keys(),c=await createChannel(s.origin,k.secret);await appendText(s.origin,k.secret,c.epoch,'persistent');
  await s.close();s=await startLocalChannels({persistPath:join(temp,'state'),vars});
  assert.equal((await readChannel(s.origin,k.address)).epoch,c.epoch);
  await delay(1100);let b=await readChannel(s.origin,k.address,c.epoch+'_0');assert.equal(b.messages.length,0);assert.equal(b.head,1);assert.equal(b.gap,true);
  const other=await keys();await assert.rejects(createChannel(s.origin,other.secret),e=>e.code==='channel_capacity');
  const remaining=Math.max(0,c.expires_at_ms-Date.now()+100);await delay(remaining);
  await code(await fetch(s.origin+'/channel/'+k.address),404);
  const again=await createChannel(s.origin,k.secret);assert.notEqual(again.epoch,c.epoch);
  await assert.rejects(readChannel(s.origin,k.address,c.epoch+'_0'),e=>e.code==='channel_replaced');
  const input={operation:'append',epoch:again.epoch,message_id:randomHex(),digest:await digest(enc.encode('x')),bytes:1};
  await challenge(s.origin,k.secret,input);
  await assert.rejects(challenge(s.origin,k.secret,{...input,message_id:randomHex()}),e=>e.code==='ticket_capacity');
});

test('ticket expiry, ingress cap, connection cap and invalid ACK', {timeout:30000},async t=>{
  const s=await fixture(t,{TICKET_SECONDS:'1',INGRESS_CAPACITY_BYTES:'8192',INGRESS_BYTES_PER_DAY:'1',MAX_SUBSCRIPTIONS:'1'}),k=await keys(),c=await createChannel(s.origin,k.secret);
  const expired=await prepared(s,k,c.epoch,'x');await delay(1100);await code(await fetch(s.origin+'/channel/'+k.address,expired),409,'ticket_spent_or_expired');
  await appendText(s.origin,k.secret,c.epoch,'a'.repeat(8192));await assert.rejects(appendText(s.origin,k.secret,c.epoch,'b'),e=>e.code==='ingress_quota');
  const sub=await socket(s.origin,k.address);t.after(()=>sub.ws.close());await sub.next();
  await code(await s.mf.dispatchFetch('http://localhost/channel/'+k.address,{headers:{Upgrade:'websocket'}}),429,'subscription_capacity');
  sub.ws.send(JSON.stringify({ack:'wrong'}));await delay(100);assert.equal(sub.closed,true);
});

test('oversized bodies consume their ticket; delivery and tiny-message costs are bounded', {timeout:30000},async t=>{
  const s=await fixture(t,{DELIVERY_CAPACITY_BYTES:'65536',DELIVERY_BYTES_PER_DAY:'1'}),k=await keys(),c=await createChannel(s.origin,k.secret);
  const req=await prepared(s,k,c.epoch,'x');
  await code(await fetch(s.origin+'/channel/'+k.address,{...req,body:'x'.repeat(8193)}),413,'body_too_large');
  await code(await fetch(s.origin+'/channel/'+k.address,req),409,'ticket_spent_or_expired');
  await appendText(s.origin,k.secret,c.epoch,'\u0000'.repeat(8192));
  await readChannel(s.origin,k.address);
  await assert.rejects(readChannel(s.origin,k.address),e=>e.code==='delivery_quota');
  const stats=await(await fetch(s.origin+'/')).text();assert.match(stats,/ingress_charged_bytes 8192\n/);
});

test('alarm initiates close for a silent reader and an acknowledged subscription lease', {timeout:15000},async t=>{
  const s=await fixture(t,{ACK_SECONDS:'1',SUBSCRIPTION_SECONDS:'2'}),k=await keys();await createChannel(s.origin,k.secret);
  const silent=await socket(s.origin,k.address);t.after(()=>silent.ws.close());await silent.next();
  const live=await socket(s.origin,k.address);t.after(()=>live.ws.close());live.ack(await live.next());
  // Local/platform alarms are asynchronous; assert eventual closure rather than
  // a precise wall-clock instant. CLOSING means the peer received the close;
  // TCP teardown may lag. No HTTP request is allowed to trigger sweep.
  const deadline=Date.now()+6500;
  while((silent.ws.readyState<WebSocket.CLOSING||live.ws.readyState<WebSocket.CLOSING)&&Date.now()<deadline)await delay(100);
  assert.ok(silent.ws.readyState>=WebSocket.CLOSING);assert.ok(live.ws.readyState>=WebSocket.CLOSING);
});

test('hibernation restores connection cursor and outstanding receipt', {timeout:15000},async t=>{
  const s=await fixture(t),k=await keys(),c=await createChannel(s.origin,k.secret);
  const sub=await socket(s.origin,k.address);t.after(()=>sub.ws.close());const first=await sub.next();
  await s.mf.unsafeEvictDurableObject('sprig-channels-v1','ChannelHub',{name:'channels-v1',webSockets:'hibernate'});
  await appendText(s.origin,k.secret,c.epoch,'after hibernation');assert.equal(sub.queue.length,0);
  sub.ack(first);const next=await sub.next();assert.equal(next.messages[0].text,'after hibernation');sub.ack(next);
});
