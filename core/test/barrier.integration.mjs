import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localCluster, configuration, origin, finish } from './barrier-local.mjs';
import { actionBytes } from '../src/action.ts';
import { textBytes, utf8, orderedU64 } from '../src/bytes.ts';
import { parseReceipt } from '../src/receipt.ts';
import { backup, incrementalBackup, verifyChain, restore } from '../scripts/recover.mjs';
const id = n => n.toString(16).padStart(32,'0');
const action = (path, body) => actionBytes({destination:origin+path,body:textBytes(body)},origin);
async function source(core, body) {
  return parseReceipt(textBytes(await core.submit(action('/sea',body))),origin).result.slice(origin.length);
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'sprig-barrier-'));
  let host = await localCluster({directory});
  t.after(async()=>{await host.dispose();await rm(directory,{recursive:true,force:true});});
  const h = { directory, get controller(){return host.controller;}, shard:name=>host.shard(name),
    async restart(options={}) { await host.dispose();host=await localCluster({directory,...options}); },
    async stop(){await host.dispose();} };
  await h.controller.initialize(); return h;
}
async function until(controller, name, wanted) {
  for(let i=0;i<64;i++){const r=await controller.status(name);if(r.phase===wanted)return r;await controller.step(name);}
  throw Error('phase did not advance');
}

test('two durable participants cut together; manifest precedes release and manual pause survives',async t=>{
  const h=await fixture(t), a=h.shard('fern'), b=h.shard('moss');
  const old=await h.controller.configuration();
  assert.deepEqual(await h.controller.initialize(),old);
  const path=await source(a,'A fern before the cut.');await source(b,'Moss before the cut.');
  await b.pause(true);
  await assert.rejects(a.cut(),/cluster_barrier_required/);
  await h.controller.start(id(1)); await until(h.controller,id(1),'cut');
  const held=await a.stats();
  await assert.rejects(a.submit(action('/sea','held')),/barrier_held/);
  await assert.rejects(a.pause(true),/barrier_held/);
  await assert.rejects(a.suppress(path,true),/barrier_held/);
  await assert.rejects(a.blockAuthor(path,true),/barrier_held/);
  assert.equal(utf8(await a.read(path)),'A fern before the cut.');
  assert.deepEqual(await a.stats(),held); // No new attempt debit while held.
  await until(h.controller,id(1),'publish');
  await assert.rejects(h.controller.published(id(1)),/barrier_not_published/);
  await assert.rejects(a.barrierRelease(id(1),old.journals.fern),/barrier_not_published/);
  await h.controller.step(id(1));
  const m=await h.controller.published(id(1));
  assert.deepEqual(Object.keys(m.cuts).sort(),['fern','moss']);
  for(const [name,cut] of Object.entries(m.cuts)) {
    assert.equal(cut.epoch,'0');assert.equal(cut.control.barrier.phase,'held');
    assert.equal(cut.control.journal,old.journals[name]);
  }
  await h.controller.step(id(1)); // fern released, moss still held; complete old cut already exists.
  await source(a,'A fern after publication.');
  assert.equal((await b.stats()).barrier.phase,'held');
  await finish(h.controller,id(1));
  assert.equal((await b.stats()).paused,true);
  await assert.rejects(b.submit(action('/sea','manual pause')),/writes_paused/);
  assert.deepEqual(await h.controller.published(id(1)),m);
  await b.pause(false);
  const before=await a.stats(); await a.barrierRelease(id(1),old.journals.fern);
  assert.deepEqual(await a.stats(),before);
});

test('an R2 upload never holds the barrier; its paid reservation and later publication straddle the cut',async t=>{
  const h=await fixture(t), a=h.shard('fern'), bytes=action('/sea','An unhurried upload.');
  await a.testCommand('hold-put',{});
  const pending=a.submit(bytes); // Attach a rejection handler before releasing the transfer.
  const outcome=pending.then(value=>({value}),error=>({error}));
  for(let i=0;i<100 && (await a.testCommand('io',{})).waiting!==1;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await a.testCommand('io',{})).waiting,1);
  await h.controller.start(id(2));await until(h.controller,id(2),'release');
  const m=await h.controller.published(id(2));
  assert.equal(m.cuts.fern.control.accepted,'0');assert.equal(m.cuts.fern.control.reservedBytes,'8192');
  await a.testCommand('release-put',{});
  assert.match((await outcome).error.message,/barrier_held/);
  await finish(h.controller,id(2));
  const receipt=await a.submit(bytes), rows=await a.testCommand('rows',{});
  assert.equal(rows.sources.length,1);assert.equal(rows.results.length,1);
  assert.equal(rows.sources[0].reserved_epoch,orderedU64('0'));assert.equal(rows.results[0].epoch,orderedU64('1'));
  assert.equal(rows.results[0].receipt,receipt);assert.equal((await a.stats()).reservedBytes,'8192');
});

test('lost replies at each barrier stage resume across process restart without extra cuts or releases',async t=>{
  for(const point of ['hold:fern','hold:moss','cut:fern','cut:moss','commit:publish','release:fern','release:moss']) {
    await t.test(point,async t=>{
      const h=await fixture(t);await source(h.shard('fern'),'fern '+point);await source(h.shard('moss'),'moss '+point);
      await h.controller.start(id(3));await h.controller.fail(point);
      let failed=false;
      for(let i=0;i<12;i++)try{await h.controller.step(id(3));}catch(e){assert.match(e.message,/injected_/);failed=true;break;}
      assert.equal(failed,true);const progress=await h.controller.status(id(3));
      await h.restart();assert.deepEqual(await h.controller.status(id(3)),progress);
      await finish(h.controller,id(3));
      for(const name of ['fern','moss']) {
        const c=h.shard(name), before=await c.stats(), rows=await c.testCommand('rows',{});
        assert.equal(before.epoch,'1');assert.equal(before.barrier.phase,'released');assert.equal(rows.cuts.length,1);
        assert.equal(rows.journal.filter(r=>r.kind==='barrier').length,2);
        await h.controller.step(id(3));assert.deepEqual(await c.stats(),before);
      }
    });
  }
});

test('wrong epochs, concurrent barriers and obsolete requests never reopen or recut a participant',async t=>{
  const h=await fixture(t), a=h.shard('fern'), j=(await h.controller.configuration()).journals.fern;
  await h.controller.start(id(4));await h.controller.step(id(4));
  const before=await a.stats();
  await assert.rejects(h.controller.start(id(5)),/barrier_in_progress/);
  await assert.rejects(a.barrierHold(id(6),'0',j),/barrier_transition/);
  await assert.rejects(a.barrierCut(id(4),'1',j),/barrier_conflict/);
  await assert.rejects(a.barrierRelease(id(6),j),/barrier_conflict/);
  assert.deepEqual(await a.stats(),before);
  await finish(h.controller,id(4));await finish(h.controller,id(5));
  const after=await a.stats();
  await assert.rejects(a.barrierHold(id(4),'0',j),/barrier_epoch_mismatch/);
  await assert.rejects(a.barrierRelease(id(4),j),/barrier_conflict/);
  assert.deepEqual(await a.stats(),after);assert.equal((await h.controller.start(id(4))).phase,'done');
});

test('changed topology or participant identity fails closed; no replacement journal is silently accepted',async t=>{
  const h=await fixture(t), a=h.shard('fern');
  await h.controller.start(id(7));await h.controller.step(id(7));
  await h.shard('moss').testCommand('journal-identity',{journal:'c'.repeat(32)});
  await assert.rejects(h.controller.step(id(7)),/barrier_journal_changed/);
  assert.equal((await a.stats()).barrier.phase,'held');
  await assert.rejects(h.controller.published(id(7)),/barrier_not_published/);
  await h.restart({topology:{...configuration,revision:'1'}});
  await assert.rejects(h.controller.configuration(),/topology_changed/);
  await assert.rejects(h.shard('fern').stats(),/incompatible_native_database/);
});

test('closed per-shard archives retain barrier facts and stay verifiable after later rounds',async t=>{
  const h=await fixture(t), a=h.shard('fern');await source(a,'archived fern');
  const m=await finish(h.controller,id(8));
  const full=join(h.directory,'full.jsonl'), first=await backup(a,full,'0');
  assert.deepEqual(first.header,m.cuts.fern);
  await source(a,'later fern');await finish(h.controller,id(9));
  const delta=join(h.directory,'delta.jsonl'), second=await incrementalBackup(a,delta,full,first.footer.chain,'1');
  await verifyChain([full,delta],second.footer.chain);
  const copy=join(h.directory,'same-cut.jsonl');await backup(a,copy,'0');
  assert.deepEqual(await readFile(full),await readFile(copy));
  const targetDirectory=join(h.directory,'restore');const target=await localCluster({directory:targetDirectory,restoring:true});
  t.after(()=>target.dispose());
  assert.equal((await restore(target.shard('fern'),full,first.footer.chain)).phase,'restored');
  await assert.rejects(target.shard('fern').restoreRelease(first.footer.chain,'history-reconciled'),/cluster_recovery_required/);
});

test('losing controller storage cannot bootstrap over participants that have already written',async t=>{
  const h=await fixture(t);await source(h.shard('fern'),'Keep this history.');
  await h.stop();
  const files=await readdir(h.directory,{recursive:true});let removed=0;
  for(const file of files.filter(f=>f.endsWith('.sqlite'))) {
    const path=join(h.directory,file), db=new DatabaseSync(path,{readOnly:true});
    const controller=db.prepare("SELECT 1 FROM sqlite_master WHERE name='barrier_registry'").get();db.close();
    if(controller){await rm(path);for(const suffix of ['-wal','-shm'])await rm(path+suffix,{force:true});removed++;}
  }
  assert.equal(removed,1);await h.restart();
  await assert.rejects(h.controller.start(id(10)),/barrier_not_initialized/);
  await assert.rejects(h.controller.initialize(),/bootstrap_requires_empty_shards/);
});


test('an incomplete manifest cannot publish or release even with every participant already cut',async t=>{
  const h=await fixture(t);await h.controller.start(id(11));await until(h.controller,id(11),'publish');
  await h.controller.omitCut(id(11),'moss');
  await assert.rejects(h.controller.step(id(11)),/archive_fields/);
  await h.restart();
  const registry=await h.controller.configuration();
  await assert.rejects(h.shard('fern').barrierRelease(id(11),registry.journals.fern),/barrier_not_published/);
  for(const name of ['fern','moss'])assert.equal((await h.shard(name).stats()).barrier.phase,'held');
});

test('loss of one participant refuses fresh admission and never silently replaces its registered identity',async t=>{
  const h=await fixture(t);await source(h.shard('moss'),'This must not reset into a fresh writer.');
  await h.stop();let removed=0;
  for(const file of (await readdir(h.directory,{recursive:true})).filter(f=>f.endsWith('.sqlite'))) {
    const path=join(h.directory,file),db=new DatabaseSync(path,{readOnly:true});
    let member=false;
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='control'").get())
      member=JSON.parse(db.prepare('SELECT value FROM control').get().value).partition?.shard==='moss';
    db.close();
    if(member){await rm(path);for(const suffix of ['-wal','-shm'])await rm(path+suffix,{force:true});removed++;}
  }
  assert.equal(removed,1);await h.restart();
  await assert.rejects(source(h.shard('moss'),'fresh replacement'),/shard_not_registered/);
  await h.controller.start(id(12));await h.controller.step(id(12));
  await assert.rejects(h.controller.step(id(12)),/barrier_journal_changed/);
  assert.equal((await h.shard('fern').stats()).barrier.phase,'held');
});
