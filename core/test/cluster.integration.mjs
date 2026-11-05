import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCluster, configuration, origin, finish, bodyOn } from './barrier-local.mjs';
import { shardFor } from '../host/topology.ts';
import { actionBytes } from '../src/action.ts';
import { contentAddress, textBytes, utf8 } from '../src/bytes.ts';
import { parseReceipt } from '../src/receipt.ts';
import { keyRecordBytes, signAction } from '../src/authority.ts';
import { canonical, digest } from '../host/archive.ts';
import { captureCluster, importCluster, verifyCluster } from '../scripts/cluster-recovery.mjs';
const id = n => n.toString(16).padStart(32,'0');
const action = (path,body='',author) => actionBytes({destination:origin+path,body:textBytes(body),author},origin);
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'sprig-cluster-'));
  let host=await localCluster({directory});
  t.after(async()=>{await host.dispose();await rm(directory,{recursive:true,force:true});});
  await host.controller.initialize();
  return {directory,get host(){return host;},async restart(options={}){await host.dispose();host=await localCluster({directory,...options});}};
}
async function nameOn(prefix,name) {
  for(let i=0;i<1000;i++) {const path=prefix+'_'+i;if(await shardFor(configuration,path)===name)return path;}
  throw Error('placement');
}
async function submit(host,path,body='',author,key) {
  const bytes=action(path,body,author), target=path==='/sea'?'/sea/'+await contentAddress(textBytes(body)):path;
  const shard=await shardFor(configuration,target), signature=key?await signAction(bytes,key,origin):null;
  const raw=await host.shard(shard).submit(bytes,signature);
  return {path:parseReceipt(textBytes(raw),origin).result.slice(origin.length),raw,shard,bytes,signature};
}
async function garden(host) {
  const source=await submit(host,'/sea',await bodyOn('fern','There is room for another fern.'));
  let pair,key;
  for(let i=0;i<100;i++) {
    pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
    const body=utf8(keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey))));
    if(await shardFor(configuration,'/sea/'+await contentAddress(textBytes(body)))==='moss') {key=await submit(host,'/sea',body);break;}
  }
  assert.ok(key);
  const plot=await submit(host,await nameOn('/plot/fern','fern'),'',key.path,pair.privateKey);
  const publication=await submit(host,await nameOn(plot.path+'/garden','moss'),source.path+'\n',plot.path,pair.privateKey);
  const chat=await submit(host,'/chat'+publication.path,'A fern speaks across the water.',plot.path,pair.privateKey);
  return {source,key,plot,publication,chat,pair};
}
async function target(t,directory) {
  let host=await localCluster({directory,restoring:true});t.after(()=>host.dispose());
  return {get host(){return host;},async restart(restoring=true){await host.dispose();host=await localCluster({directory,restoring});}};
}
async function bundle(h,number=1,bases=null) {
  const dir=join(h.directory,'backup-'+number);await mkdir(dir);
  await finish(h.host.controller,id(number));return captureCluster(h.host,dir,id(number),bases);
}
async function restoreAll(h,b) {
  const checked=await verifyCluster(b.plan,b.files,b.digest);
  await h.controller.restoreBegin(canonical(b.plan),b.digest,'old-writers-fenced');
  await checked.restore(h);
  for(let i=0;i<100;i++) {const s=await h.controller.restoreStep(b.digest);if(s.phase==='done')return s;}
  throw Error('restore_step_limit');
}

test('registered ownership, signed remote keys/plots, chat, evidence and bounded inspection',async t=>{
  const h=await fixture(t), g=await garden(h.host);
  for(const v of [g.source,g.key,g.plot,g.publication,g.chat]) {
    const core=h.host.shard(v.shard);
    assert.equal((await core.describe(v.path)).path,v.path);
    assert.equal((await core.evidence(v.path)).receipt,v.raw);
    assert.equal(await core.submit(v.bytes,v.signature),v.raw);
  }
  assert.equal(utf8(await h.host.shard(g.chat.shard).read(g.chat.path)),'A fern speaks across the water.');
  const wrong=g.source.shard==='fern'?'moss':'fern';
  await assert.rejects(h.host.shard(wrong).submit(g.source.bytes),/wrong_shard/);
  assert.equal((await h.host.shard(wrong).testCommand('rows',{})).results.some(r=>r.path===g.source.path),false);
  const other=await submit(h.host,'/chat'+g.publication.path+'/0','A second leaf.',g.plot.path,g.pair.privateKey);
  assert.equal(other.path,'/chat'+g.publication.path+'/1');
  const page=await h.host.shard(other.shard).browse({kind:'chat',container:'/chat'+g.publication.path,after:''});
  assert.equal(page.items.length,2);
  const journals=(await h.host.controller.configuration()).journals;
  await assert.rejects(h.host.shard('fern').referenceFact(g.source.path,'a'.repeat(32)),/shard_not_registered/);
  assert.equal((await h.host.shard('fern').referenceFact(g.source.path,journals.fern)).path,g.source.path);
});

test('private uploaded bytes cannot supply a remote reference; local anchors and controller authority still gate commits',async t=>{
  const h=await fixture(t),g=await garden(h.host),a=h.host.shard('fern');
  const body=await bodyOn('fern','Not published yet'),path='/sea/'+await contentAddress(textBytes(body));
  await a.testCommand('hold',{});const pending=a.submit(action('/sea',body));
  for(let i=0;i<100&&(await a.testCommand('waiting',{}))!==1;i++)await new Promise(r=>setTimeout(r,10));
  await assert.rejects(submit(h.host,await nameOn('/grove/unaccepted','moss'),path+'\n'),/entry_unavailable/);
  await a.testCommand('release',{});await pending;
  await assert.rejects(submit(h.host,g.publication.path.slice(0,-2),g.source.path+'\n',g.key.path),/signature_required/);
  await assert.rejects(submit(h.host,'/chat'+g.publication.path+'/100','Too far.'),/anchor_unavailable/);
});

test('one authority, durable policy catch-up and independent manual pause survive barriers',async t=>{
  const h=await fixture(t),g=await garden(h.host);
  await assert.rejects(h.host.shard('moss').suppress(g.source.path,true),/policy_authority_required/);
  await h.host.shard('fern').suppress(g.source.path,true);
  await h.restart();
  await assert.rejects(h.host.shard(g.publication.shard).read(g.publication.path),/suppressed/);
  assert.equal((await h.host.shard('moss').stats()).moderation,'1');
  await h.host.shard('fern').blockAuthor(g.key.path,true);await h.restart();
  await assert.rejects(submit(h.host,'/sea',await bodyOn('moss','A blocked signature'),g.plot.path,g.pair.privateKey),/author_blocked/);
  await h.host.shard('moss').pause(true);await finish(h.host.controller,id(3));
  assert.equal((await h.host.shard('moss').stats()).paused,true);
});

test('full plus delta cluster restores signatures, receipts, numbers, moderation and cross-owner dependencies',async t=>{
  const h=await fixture(t),g=await garden(h.host), first=await bundle(h,4);
  await submit(h.host,'/chat'+g.publication.path+'/0','A second leaf.',g.plot.path,g.pair.privateKey);
  await h.host.shard('fern').blockAuthor(g.key.path,true);await h.restart();
  await h.host.shard('moss').read(g.publication.path); // Persist the follower prefix.
  const bases=Object.fromEntries(Object.keys(first.files).map(n=>[n,{files:first.files[n],digest:first.plan.finals[n].footer.chain}]));
  const b=await bundle(h,5,bases), targetHost=await target(t,join(h.directory,'restored'));
  await restoreAll(targetHost.host,b);
  const states={};for(const n of ['fern','moss']) {
    const c=await targetHost.host.shard(n).stats();states[n]=c;
    assert.equal(c.paused,true);assert.equal(c.epoch,'2');
    assert.equal(c.growth.tokens,0);assert.equal(c.burst.tokens,0);assert.equal(c.attempts.tokens,0);
  }
  await assert.rejects(targetHost.host.shard(g.source.shard).read(g.source.path),/recovery_mode/);
  await targetHost.restart(false);
  for(const v of [g.source,g.key,g.plot,g.publication,g.chat]) {
    assert.equal((await targetHost.host.shard(v.shard).evidence(v.path)).receipt,v.raw);
  }
  for(const n of ['fern','moss'])assert.deepEqual(await targetHost.host.shard(n).stats(),states[n]);
  const chatRoot='/chat'+g.publication.path;
  assert.equal(await targetHost.host.shard(g.chat.shard).latest(chatRoot),chatRoot+'/1');
  assert.deepEqual(await targetHost.host.controller.published(id(4)),first.plan.boundary);
  assert.equal((await targetHost.host.controller.start(id(4))).phase,'done');
  // Restored barrier history is usable, and another backup remains internally consistent.
  await finish(targetHost.host.controller,id(6));
  const nextDir=join(h.directory,'backup-restored');await mkdir(nextDir);
  const again=await captureCluster(targetHost.host,nextDir,id(6));await verifyCluster(again.plan,again.files,again.digest);
});

test('missing member/delta, foreign digest, early release and removing restore configuration all fail closed',async t=>{
  const h=await fixture(t);await garden(h.host);const b=await bundle(h,7),r=await target(t,join(h.directory,'restore'));
  await assert.rejects(verifyCluster(b.plan,{fern:b.files.fern},b.digest),/cluster_backup_missing_member/);
  await assert.rejects(verifyCluster(b.plan,b.files,'0'.repeat(64)),/cluster_trusted_digest_mismatch/);
  await r.host.controller.restoreBegin(canonical(b.plan),b.digest,'old-writers-fenced');
  await assert.rejects(r.host.controller.restoreStep(b.digest),/cluster_member_not_restored/);
  await assert.rejects(r.host.shard('fern').clusterRelease(b.digest),/cluster_restore_not_verified/);
  await r.restart(false);
  await assert.rejects(r.host.controller.initialize(),/recovery_mode/);
  await assert.rejects(r.host.shard('fern').submit(action('/sea','premature')),/recovery_mode/);
  await r.restart(true);await restoreAll(r.host,b);
});

test('lost replies at each restore stage resume without duplicate release or replenished credit',async t=>{
  for(const point of ['restore-import:fern','restore-verify:fern','restore-verify:moss','restore-history:fern','commit:restore-publish','restore-release:fern','restore-release:moss'])await t.test(point,async t=>{
    const h=await fixture(t);await garden(h.host);await finish(h.host.controller,id(80));const b=await bundle(h,8),r=await target(t,join(h.directory,'restore'));
    await r.host.controller.restoreBegin(canonical(b.plan),b.digest,'old-writers-fenced');await importCluster(r.host,b,b.digest);
    await r.host.controller.fail(point);let failed=false;
    for(let i=0;i<30;i++)try{await r.host.controller.restoreStep(b.digest);}catch(e){assert.match(e.message,/injected_/);failed=true;break;}
    assert.equal(failed,true);await r.restart();await restoreAll(r.host,b);
    const before=await r.host.shard('fern').stats();await r.host.shard('fern').clusterRelease(b.digest);
    assert.deepEqual(await r.host.shard('fern').stats(),before);
    const rows=await r.host.shard('fern').testCommand('rows',{});
    assert.equal(rows.journal.filter(x=>x.kind==='barrier').length,4);
  });
});


test('an in-flight cross-owner acceptance cannot commit in the closed epoch',async t=>{
  const h=await fixture(t),g=await garden(h.host),c=h.host.shard(g.chat.shard);
  await c.testCommand('hold',{});
  const pending=submit(h.host,'/chat'+g.publication.path+'/0','Across a boundary.');
  const outcome=pending.then(value=>({value}),error=>({error}));
  for(let i=0;i<100&&(await c.testCommand('waiting',{}))!==1;i++)await new Promise(r=>setTimeout(r,10));
  await h.host.controller.start(id(9));
  for(let i=0;i<20;i++){if((await h.host.controller.status(id(9))).phase==='release')break;await h.host.controller.step(id(9));}
  await c.testCommand('release',{});assert.match((await outcome).error.message,/barrier_held/);
  await finish(h.host.controller,id(9));
  const accepted=await submit(h.host,'/chat'+g.publication.path+'/0','Across a boundary.');
  const rows=await c.testCommand('rows',{});
  assert.equal(rows.results.find(r=>r.path===accepted.path).epoch,'00000000000000000001');
});

test('verification is paged and a missing remote accepted dependency keeps every member quarantined',async t=>{
  const h=await fixture(t),g=await garden(h.host);
  for(let i=0;i<40;i++)await submit(h.host,'/chat'+g.publication.path,'leaf '+i);
  const b=await bundle(h,10),r=await target(t,join(h.directory,'restore'));
  await r.host.controller.restoreBegin(canonical(b.plan),b.digest,'old-writers-fenced');await importCluster(r.host,b,b.digest);
  await r.host.controller.restoreStep(b.digest);await r.host.controller.restoreStep(b.digest);
  const first=await r.host.shard(g.chat.shard).clusterVerify(b.digest);
  assert.equal(first.done,false);assert.equal(first.after,'32');
  await r.restart();
  // Corrupt retained acceptance after import: raw R2 still contains the bytes.
  await r.host.shard(g.source.shard).testCommand('delete-result',{path:g.source.path});
  const other=g.source.shard==='fern'?'moss':'fern';
  await assert.rejects(r.host.shard(other).clusterVerify(b.digest),/archive_missing_result/);
  await assert.rejects(r.host.shard(other).clusterRelease(b.digest),/cluster_restore_not_verified/);
  await r.restart(false);
  for(const n of ['fern','moss'])await assert.rejects(r.host.shard(n).read(g.source.path),/recovery_mode/);
});

test('partial suffixes and divergent follower policy cannot become a released cluster',async t=>{
  const h=await fixture(t),g=await garden(h.host),first=await bundle(h,11);
  await h.host.shard('fern').blockAuthor(g.key.path,true);await h.restart();await h.host.shard('moss').read(g.key.path);
  const bases=Object.fromEntries(Object.keys(first.files).map(n=>[n,{files:first.files[n],digest:first.plan.finals[n].footer.chain}]));
  const b=await bundle(h,12,bases);
  await assert.rejects(verifyCluster(b.plan,{...b.files,moss:[b.files.moss[1]]},b.digest),/restore_requires_snapshot/);
  await assert.rejects(verifyCluster(b.plan,{...b.files,moss:[b.files.moss[0]]},b.digest),/archive_trusted_digest_mismatch/);
  const r=await target(t,join(h.directory,'restore'));
  await r.host.controller.restoreBegin(canonical(b.plan),b.digest,'old-writers-fenced');await importCluster(r.host,b,b.digest);
  await r.host.shard('fern').testCommand('delete-policy',{position:'00000000000000000001'});
  await assert.rejects(r.host.shard('moss').clusterVerify(b.digest),/archive_missing_policy/);
  await assert.rejects(r.host.controller.restorePublished(b.digest),/cluster_restore_not_verified/);
});


test('the shared bucket is checked once before import; a dirty target cannot authorize any member',async t=>{
  const h=await fixture(t);await garden(h.host);const b=await bundle(h,13),r=await target(t,join(h.directory,'restore'));
  await r.host.shard('fern').testCommand('corrupt',{address:'private-existing',body:'still here'});
  await assert.rejects(r.host.controller.restoreBegin(canonical(b.plan),b.digest,'old-writers-fenced'),/restore_requires_empty_bucket/);
  assert.equal((await r.host.controller.restoreStatus()).phase,'starting');
  await assert.rejects(importCluster(r.host,b,b.digest),/cluster_restore_not_ready/);
  await r.restart();
  await assert.rejects(r.host.controller.restoreBegin(canonical(b.plan),b.digest,'old-writers-fenced'),/restore_requires_empty_bucket/);
  for(const name of ['fern','moss'])assert.equal((await r.host.shard(name).stats()).accepted,'0');
});
