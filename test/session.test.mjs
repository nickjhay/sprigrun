import test from 'node:test';
import assert from 'node:assert/strict';
import { RunSession } from '../src/run-session.ts';
class Worker {
  onmessage=null;onerror=null;sent=[];terminated=0;
  postMessage(m){this.sent.push(m);}terminate(){this.terminated++;}
  message(m){this.onmessage?.({data:m});}
}
const message={module:'/runtime/moss.js',bytes:new Uint8Array()};
const limits={computeMs:1000,sessionMs:5000,inputMs:1000,loadMs:1000};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(overrides={}){const workers=[],session=new RunSession(()=>{const w=new Worker();workers.push(w);return w;});const io={input:async()=>'',load:async()=>new Uint8Array(),output:()=>{},status:()=>{},...overrides};return {session,workers,io};}

test('terminal wait pauses compute budget, then returns a correlated reply',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let answer;
  const {session,workers,io}=setup({input:()=>new Promise(r=>answer=r)});
  const result=session.run(message,io,limits);workers[0].message({type:'request',id:1,op:'input',value:'Name?'});await tick();
  t.mock.timers.tick(500);assert.equal(session.busy,true);
  answer('Ada');await tick();assert.deepEqual(workers[0].sent[1],{type:'reply',id:1,value:'Ada'});
  workers[0].message({type:'done',value:{summary:'done'}});assert.deepEqual(await result,{summary:'done'});
});
test('Stop aborts pending I/O and a late answer cannot reach the next run',async()=>{
  let answer,signal;const {session,workers,io}=setup({input:(_,s)=>{signal=s;return new Promise(r=>answer=r);}});
  const first=session.run(message,io,limits),failure=assert.rejects(first,/Stopped/);
  workers[0].message({type:'request',id:1,op:'input',value:'?'});await tick();session.cancel();await failure;assert.equal(signal.aborted,true);
  const second=session.run(message,io,limits);answer('late');await tick();assert.equal(workers[1].sent.length,1);
  workers[1].message({type:'done',value:{summary:'new'}});await second;
});
test('input timeout and overall session timeout terminate the worker',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {session,workers,io}=setup({input:()=>new Promise(()=>{})});
  const p=session.run(message,io,limits),failure=assert.rejects(p,/Input timed out/);
  workers[0].message({type:'request',id:1,op:'input',value:'?'});await tick();t.mock.timers.tick(1001);await failure;assert.equal(workers[0].terminated,1);
  const p2=session.run(message,io,{...limits,inputMs:10000}),failure2=assert.rejects(p2,/Time limit/);
  workers[1].message({type:'request',id:1,op:'input',value:'?'});await tick();t.mock.timers.tick(5001);await failure2;
});
test('multiple concurrent I/O requests are rejected before invoking a second capability',async()=>{
  let calls=0;const {session,workers,io}=setup({input:()=>{calls++;return new Promise(()=>{});}});
  const p=session.run(message,io,limits),failure=assert.rejects(p,/Invalid or excessive/);
  workers[0].message({type:'request',id:1,op:'input',value:'?'});await tick();
  workers[0].message({type:'request',id:2,op:'input',value:'?'});await failure;assert.equal(calls,1);
});
