import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerJob } from '../src/jobs.ts';
import { OutputBuffer, runtimeURL } from '../src/runtime-contract.ts';
class FakeWorker {
  onmessage=null;onerror=null;terminated=0;sent=[];
  postMessage(value){this.sent.push(value);}
  terminate(){this.terminated++;}
  message(data){this.onmessage?.({data});}
}
function setup(){const workers=[];const job=new WorkerJob(()=>{const w=new FakeWorker();workers.push(w);return w;});return {job,workers};}

test('cancel settles the promise and suppresses late output',async()=>{
  const {job,workers}=setup(),events=[];
  const pending=job.run({},1000,e=>events.push(e));
  job.cancel();await assert.rejects(pending,/Canceled/);
  workers[0].message({type:'output',text:'late'});workers[0].message({type:'done',value:4});
  assert.equal(job.busy,false);assert.equal(workers[0].terminated,1);assert.deepEqual(events,[]);
});

test('replacing a worker prevents its late result from completing the new job',async()=>{
  const {job,workers}=setup();const first=job.run({},1000),rejected=assert.rejects(first,/Canceled/);
  const second=job.run({},1000);workers[0].message({type:'done',value:'stale'});
  assert.equal(job.busy,true);workers[1].message({type:'done',value:'current'});
  assert.equal(await second,'current');await rejected;assert.equal(workers[1].terminated,1);
});

test('unresponsive workers are terminated at the host deadline',async()=>{
  const {job,workers}=setup();await assert.rejects(job.run({},10),/Time limit/);
  assert.equal(workers[0].terminated,1);assert.equal(job.busy,false);
});

test('worker startup and output handler failures settle without leaving a live worker',async()=>{
  const job=new WorkerJob(()=>{throw new Error('startup');});await assert.rejects(job.run({},1000),/startup/);assert.equal(job.busy,false);
  const {job:j,workers}=setup();const p=j.run({},1000,()=>{throw new Error('handler');});
  workers[0].message({type:'output'});await assert.rejects(p,/handler/);assert.equal(workers[0].terminated,1);
  const p2=j.run({},1000);workers[1].onerror({});await assert.rejects(p2,/worker could not start/);assert.equal(j.busy,false);
});

test('output remains bounded under many or huge messages and does not coerce objects',()=>{
  const b=new OutputBuffer(10);b.append('hello');b.append({toString(){throw new Error('coercion');}});b.append('x'.repeat(100000));
  for(let i=0;i<100;i++)b.append('more');assert.equal(b.text,'helloxxxxx');assert.equal(b.truncated,true);
});

test('runtime URLs cannot select remote modules or escape the owner runtime directory',()=>{
  assert.equal(runtimeURL('/runtime/v1/adapter.js','https://sprig.test'),'https://sprig.test/runtime/v1/adapter.js');
  for(const path of ['https://evil.test/runtime/a.js','/runtime/../assets/a.js','/runtime/a.js?source=evil','/runtime/a.js#x','/b/a.js','data:text/javascript,alert(1)'])assert.throws(()=>runtimeURL(path,'https://sprig.test'));
});
