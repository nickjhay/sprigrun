import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';
import {SourceDocument,encodeDraft,decodeDraft,addressOf} from '../src/document.ts';
import {badgeToDigest} from '../src/hash-badge.ts';
import {serveStatic} from '../scripts/static-server.mjs';

// DOM/controller integration, not browser layout or native editing emulation.
const html=await readFile('index.html','utf8');
const settings={publishWorker:'/publish.js',runtimeWorker:'/worker.js',runtimeModule:'/runtime/moss.js',runtimeVersion:'Moss / 1',storeOrigin:'http://localhost:8787',local:true,demo:{library:'',program:''}};
const bundle=await build({entryPoints:['src/main.ts'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'},define:{__BUILD__:JSON.stringify(settings)}});
const code=bundle.outputFiles[0].text;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<8;i++)await tick();}
async function until(predicate){const end=performance.now()+2000;while(!predicate()&&performance.now()<end)await new Promise(resolve=>setTimeout(resolve,5));}
const key='sprig-workbench:draft:v1';

function fixture(t,path='/workspace',{saved='#!moss/1\n"hello" print\n',fetcher=()=>{throw new Error('Unexpected network access');}}={}){
  const {window,document}=parseHTML(html),workers=[],timers=new Set();
  const values=new Map(saved===null?[]:[[key,encodeDraft(new SourceDocument(new TextEncoder().encode(saved)).snapshot())]]);
  const location=new URL(path,'http://localhost:5173');
  const editor=document.getElementById('source');
  let focused=document.body;
  Object.defineProperty(document,'activeElement',{get:()=>focused});
  // LinkeDOM does not implement browser focus, textarea selection or layout.
  for(const node of document.querySelectorAll('button,input,textarea,a'))node.focus=()=>{focused=node;};
  editor.setSelectionRange=(a,b)=>{editor.selectionStart=a;editor.selectionEnd=b;};
  editor.setRangeText=(text,a,b)=>{editor.value=editor.value.slice(0,a)+text+editor.value.slice(b);editor.setSelectionRange(a+text.length,a+text.length);};
  editor.scrollTop=0;editor.scrollLeft=0;Object.defineProperty(editor,'clientHeight',{value:300});
  class Worker {
    onmessage=null;onerror=null;sent=[];terminated=0;
    constructor(url){this.url=url;workers.push(this);}
    postMessage(message){this.sent.push(message);}
    terminate(){this.terminated++;}
    message(data){this.onmessage?.({data});}
  }
  const localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const context={window,document,location,history:{replaceState:(_,__,path)=>{location.href=new URL(path,location).href;}},localStorage,Worker,
    URL,Blob,TextEncoder,TextDecoder,AbortController,AbortSignal,DOMException,Error,Uint8Array,ArrayBuffer,Response,Headers,crypto:webcrypto,performance,
    Event:window.Event,HTMLInputElement:window.HTMLInputElement,HTMLTextAreaElement:window.HTMLTextAreaElement,
    ResizeObserver:class{observe(){}},requestAnimationFrame:fn=>queueMicrotask(fn),confirm:()=>true,
    navigator:{clipboard:{writeText:async text=>{context.copied=text;}}},atob,btoa,fetch:fetcher,
    setTimeout:(fn,delay)=>{const id=setTimeout(()=>{timers.delete(id);fn();},delay);timers.add(id);return id;},clearTimeout:id=>{timers.delete(id);clearTimeout(id);}};
  runInNewContext(code,context);
  const el=id=>document.getElementById(id);
  const event=(id,type)=>el(id).dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));
  const edit=text=>{editor.value=text;event('source','input');};
  const close=()=>{window.dispatchEvent(new window.Event('pagehide'));for(const id of timers)clearTimeout(id);};
  t.after(close);
  return {document,window,workers,values,location,editor,el,event,edit,context};
}

test('overlay keeps the editor node, draft, selection and scroll through collapse and worker restart',async t=>{
  const f=fixture(t),{editor,el,workers}=f;
  assert.equal(el('home').hidden,true);assert.equal(el('overlay-panel').hidden,false);
  assert.equal(el('source'),editor);assert.equal(el('source').closest('#overlay-source')?.id,'overlay-source');
  f.edit('#!moss/1\n"pending" input print\n');editor.setSelectionRange(3,8);editor.scrollTop=60;editor.focus();
  el('overlay-toggle').click();assert.equal(el('overlay-panel').hidden,true);assert.equal(f.document.activeElement,el('overlay-toggle'));
  el('overlay-toggle').click();assert.equal(el('source'),editor);assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.scrollTop],[3,8,60]);
  el('run').click();await settle();assert.equal(workers.length,1);assert.equal(el('run').textContent,'↻ Restart');
  workers[0].message({type:'request',id:1,op:'input',value:'Name? '});await settle();
  assert.equal(el('terminal-form').hidden,false);assert.equal(f.document.activeElement,editor,'background input must not steal editor focus');
  f.edit('#!moss/1\n"newer" print\n');editor.setSelectionRange(4,7);
  const old=workers[0],late=old.onmessage;
  el('run').click();await settle();assert.equal(workers.length,2);assert.equal(old.terminated,1);
  assert.equal(el('terminal-form').hidden,true);assert.equal(el('source'),editor);assert.deepEqual([editor.selectionStart,editor.selectionEnd],[4,7]);
  late({data:{type:'output',text:'OLD OUTPUT'}});late({data:{type:'done',value:{summary:'OLD DONE'}}});await settle();
  assert.equal(el('output').textContent,'');assert.equal(el('run-state').textContent,'Running…');
  workers[1].message({type:'output',text:'newer\n'});workers[1].message({type:'done',value:{summary:'done'}});await settle();
  assert.equal(el('output').textContent,'newer\n');assert.equal(editor.value,'#!moss/1\n"newer" print\n');
  f.window.dispatchEvent(new f.window.Event('pagehide'));
  assert.equal(new TextDecoder().decode(decodeDraft(f.values.get(key)).bytes),editor.value);
});

test('an older publication cannot relabel a newer draft with its hash',async t=>{
  const f=fixture(t),{el,workers}=f;
  const captured=f.editor.value,address=await addressOf(new TextEncoder().encode(captured));
  el('publish').click();await settle();assert.equal(workers[0].url,'/publish.js');
  f.edit('#!moss/1\n"new draft" print\n');
  workers[0].message({type:'done',value:address});await settle();
  assert.equal(el('hash-badge').hidden,true);assert.equal(el('direct-link').hidden,true);
  assert.equal(el('identity-label').textContent,'Local draft');assert.match(el('published-state').textContent,/Earlier snapshot/);
  assert.equal(f.editor.value,'#!moss/1\n"new draft" print\n');
});

test('verified shared and direct routes use identical source, preserve the saved draft, and never autorun',async t=>{
  const bytes=new TextEncoder().encode('#!moss/1\n"shared" print\n'),address=await addressOf(bytes);
  for(const prefix of ['r','run']){
    const f=fixture(t,'/'+prefix+'/'+address,{fetcher:async()=>new Response(bytes,{headers:{'Content-Length':String(bytes.length)}})});
    await until(()=>f.editor.value.length>0||f.el('notice').classList.contains('error'));
    assert.equal(f.editor.value,new TextDecoder().decode(bytes),f.el('notice').textContent);assert.equal(f.editor.readOnly,true);
    assert.equal(f.workers.length,0);assert.equal(f.el('run').disabled,false);
    assert.equal(f.el('overlay').hidden,prefix==='run');assert.equal(f.el('overlay-panel').hidden,true);
    assert.equal(f.el('direct-link').getAttribute('href'),'/run/'+address);
    assert.equal(badgeToDigest(f.el('hash-grid').textContent.replaceAll('\n','')),address.split('_')[0]);
    if(prefix==='r'){f.el('overlay-toggle').click();f.el('hash-badge').click();await settle();assert.equal(f.context.copied,address);}
    f.window.dispatchEvent(new f.window.Event('pagehide'));
    assert.match(new TextDecoder().decode(decodeDraft(f.values.get(key)).bytes),/hello/);
  }
});

test('invalid and unavailable shared URLs cannot fall back to running or overwriting a private draft',async t=>{
  for(const path of ['/run/not-an-address','/r/'+'a'.repeat(64)+'_4']){
    const f=fixture(t,path,{fetcher:async()=>new Response('missing',{status:404})});await settle();
    assert.equal(f.editor.value,'');assert.equal(f.el('run').disabled,true);assert.equal(f.el('publish').disabled,true);
    f.el('run').click();await settle();assert.equal(f.workers.length,0);
    f.window.dispatchEvent(new f.window.Event('pagehide'));
    assert.match(new TextDecoder().decode(decodeDraft(f.values.get(key)).bytes),/hello/);
  }
});

test('local HTTP routes serve the shared, direct and workspace shell with the same security headers',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sprig-routes-'));await writeFile(join(dir,'index.html'),html);
  const server=await serveStatic({directory:dir,port:0});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+server.address().port,address='0'.repeat(64)+'_0';
  for(const path of ['/','/workspace','/r/'+address,'/w/'+address,'/run/'+address]){
    const r=await fetch(origin+path);assert.equal(r.status,200);assert.match(r.headers.get('Content-Security-Policy'),/default-src 'none'/);assert.match(await r.text(),/id="overlay-panel"/);
  }
  assert.equal((await fetch(origin+'/workspace/unknown')).status,404);
});
