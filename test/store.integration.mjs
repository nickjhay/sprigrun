import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { startLocalStore } from '../scripts/local-store.mjs';
import { seed } from '../scripts/seed.mjs';
import { loadSource } from '../store/examples/client.ts';
import { SourceDocument,addressOf } from '../src/document.ts';
import { WorkerJob } from '../src/jobs.ts';
import { RunSession } from '../src/run-session.ts';
import { ContentLoader } from '../src/content-loader.ts';

class NodePort {
  onmessage=null;onerror=null;queue=[];ready=false;
  constructor(data){
    this.worker=new Worker(new URL('./node-worker.mjs',import.meta.url),{workerData:data});
    this.worker.on('message',m=>{if(m.type==='ready'){this.ready=true;for(const item of this.queue)this.worker.postMessage(item);this.queue=[];}else this.onmessage?.({data:m});});
    this.worker.on('error',error=>this.onerror?.(error));
  }
  postMessage(m){if(this.ready)this.worker.postMessage(m);else this.queue.push(m);}
  terminate(){void this.worker.terminate();}
}

test('local stack: real proof/upload, restart persistence, verified graft, worker execution and terminal input', {timeout:60000},async t=>{
  const temp=await mkdtemp(join(tmpdir(),'sprig-local-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  let store=await startLocalStore({persistPath:join(temp,'state'),vars:{PROOF_OF_WORK_BITS:'8',PROOF_OF_WORK_PER_BYTE:'1'}});
  t.after(()=>store.close());
  const files={};
  for(const [name,entry] of Object.entries({publisher:'src/publish-worker.ts',runtime:'src/runtime-worker.ts',adapter:'src/moss/adapter.ts'})){
    const file=join(temp,name+'.mjs');await build({entryPoints:[entry],outfile:file,bundle:true,format:'esm',platform:'browser'});files[name]=pathToFileURL(file).href;
  }
  const publish=bytes=>new WorkerJob(()=>new NodePort({module:files.publisher})).run({origin:store.origin,bytes},15000);
  const original=Buffer.from('\ufeff#!moss/1\r\n"café" print\r\n'),doc=new SourceDocument(original),snapshot=doc.snapshot();
  const pending=publish(snapshot.bytes);doc.edit('newer source');const address=await pending;
  assert.equal(address,await addressOf(new Uint8Array(original)));
  assert.deepEqual(Buffer.from((await loadSource(store.origin,address)).bytes),original);assert.equal(doc.text,'newer source');
  assert.equal(await publish(new Uint8Array(original)),address);
  const demo=await seed(store.origin);
  await store.close();
  store=await startLocalStore({persistPath:join(temp,'state')});
  const root=await loadSource(store.origin,demo.programAddress);
  const loader=new ContentLoader(store.origin,root.bytes.length);
  const adapterURL='https://sprig.test/runtime/moss.js';
  const session=new RunSession(()=>new NodePort({module:files.runtime,adapter:files.adapter,adapterURL}));
  let output='',loads=0;const prompts=[];
  const result=await session.run({module:adapterURL,bytes:root.bytes},{
    input:async prompt=>{prompts.push(prompt);return 'Ada';},
    load:async(address,signal)=>{loads++;return loader.load(address,signal);},
    output:text=>output+=text,status:()=>{},
  });
  assert.deepEqual(prompts,['Who is visiting? ']);assert.equal(loads,1);
  assert.equal(output,'Hello, Ada!\nThe moss predicts a small, excellent rain.\nSeven squared: 49\ndesserts\n');
  assert.match(result.summary,/Moss finished/);

  // The new resident is also a real stored root with a separately verified graft.
  const fern=await loadSource(store.origin,demo.fernProgramAddress);
  const fernLoader=new ContentLoader(store.origin,fern.bytes.length),answers=['Koru','',''];
  let fernOutput='',fernLoads=0;
  const fernResult=await session.run({module:adapterURL,bytes:fern.bytes},{
    input:async()=>{assert.ok(answers.length);return answers.shift();},
    load:async(address,signal)=>{assert.equal(address,demo.fernLibraryAddress);fernLoads++;return fernLoader.load(address,signal);},
    output:text=>fernOutput+=text,status:()=>{},
  });
  assert.equal(answers.length,0);assert.equal(fernLoads,1);
  assert.ok(fernOutput.includes('╱╱╱╱╱     │     ╲╲╲╲╲'));
  assert.ok(fernOutput.endsWith('Koru is here. The morning can take its time.\n'));
  assert.match(fernResult.summary,/Moss finished/);
  await assert.rejects(loadSource(store.origin,'0'.repeat(64)+'_1'),/404/);
  const response=await fetch(store.origin+'/b/'+demo.programAddress);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');assert.match(response.headers.get('Cache-Control'),/^private/);
  const stats=await (await fetch(store.origin+'/')).text();assert.match(stats,/confirmed_unblocked_blobs 5\n/);
});
