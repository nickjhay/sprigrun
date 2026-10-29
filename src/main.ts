import './style.css';
import './overlay.css';
import { requireHashing, decodeSource, SourceDocument, INITIAL_SOURCE, WORLD_SOURCE, MAX_SOURCE_BYTES, safeName, storeOrigin, workbenchRoute, shareURL, encodeDraft, decodeDraft } from './document.ts';
import { WorkbenchView } from './workbench-view.ts';
import { loadSource } from '../store/examples/client.ts';
import { parseAddress } from '../store/src/proof.ts';
import { WorkerJob } from './jobs.ts';
import { RUN_LIMITS, OutputBuffer, runtimeURL } from './runtime-contract.ts';

declare const __BUILD__: {publishWorker:string;runtimeWorker:string;storeOrigin:string;runtimeModule:string|null;runtimeVersion:string|null;demo:{library:string;program:string;fern:string;fernProgram:string};local:boolean};
const build=__BUILD__;
import { RunSession } from './run-session.ts';
import { ContentLoader } from './content-loader.ts';
const element=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const editor=element<HTMLTextAreaElement>('source');
const filename=element<HTMLInputElement>('filename');
const source=new SourceDocument();
const view=new WorkbenchView();
const DRAFT='sprig-workbench:draft:v1', STORE='sprig-workbench:store:v1';
let origin='',isShared=false,hasEdits=false,saveTimer:ReturnType<typeof setTimeout>|undefined;
let pendingShared:string|null=null,loadGeneration=0,publishGeneration=0,runGeneration=0;
let invalidRoute=false,runRevision:number|undefined,runAddress:string|null=null;
let loadAbort:AbortController|undefined;
let lastPublished:{address:string;origin:string;revision:number}|undefined;
const publishJob=new WorkerJob(()=>new Worker(build.publishWorker,{type:'module'}));
const runJob=new RunSession(()=>new Worker(build.runtimeWorker,{type:'module'}));
const output=element<HTMLPreElement>('output');
let runtime:string|null=null;
try { if(build.runtimeModule)runtime=runtimeURL(build.runtimeModule,location.origin); } catch(error) { notice(String(error),true); }

function notice(message:string,error=false):void {
  const box=element('notice');box.textContent=message;box.hidden=!message;box.classList.toggle('error',error);
}
function updateButtons():void {
  element<HTMLButtonElement>('publish').disabled=!origin||publishJob.busy||pendingShared!==null||invalidRoute;
  element('publish').classList.toggle('running',publishJob.busy);
  element('publish').textContent=publishJob.busy?'Publishing…':view.kind==='home'?'Publish source ↗':'Publish ↗';
  element('cancel-publish').hidden=!publishJob.busy;
  element<HTMLButtonElement>('run').disabled=!runtime||pendingShared!==null||invalidRoute;
  element('run').textContent=runJob.busy?'↻ Restart':'▷ Run';
  element('stop-run').hidden=!runJob.busy;
  element<HTMLButtonElement>('clear-output').disabled=runJob.busy;
  element('fork').hidden=!isShared;
}
function updateRunBasis():void {
  if(runRevision===undefined){view.runBasis(pendingShared?'Verifying source…':'Press Run to begin.');return;}
  const kind=runAddress?'published source':'draft snapshot';
  view.runBasis((runJob.busy?'Running ':'Last run · ')+kind+(source.revision===runRevision?'':' · editor has changed'));
}
function updateMetrics():void {
  element('byte-count').textContent=`${source.length.toLocaleString()} bytes`;
  element('encoding').textContent=source.originalBytes?'UTF-8 · exact bytes':'UTF-8 · LF';
  element('doc-state').textContent=pendingShared?'SHARED LINK':isShared?'VERIFIED':'DRAFT';
  const before=editor.value.slice(0,editor.selectionStart);
  const lines=before.split('\n');
  element('position').textContent=`Ln ${lines.length}, Col ${(lines.at(-1)?.length??0)+1}`;
  const current=lastPublished?.revision===source.revision?lastPublished.address:null;
  view.identity(current,invalidRoute?'Invalid source':pendingShared?'Verifying source':isShared?'Verified source':current?'Published draft':'Local draft',source.length);
  updateRunBasis();
  lineNumbers();
}
function lineNumbers():void {
  // Paint only visible line numbers, even for a file with 200,000 empty lines.
  const total=editor.value.split('\n').length;
  const first=Math.max(0,Math.floor((editor.scrollTop-22)/25));
  const count=Math.ceil(editor.clientHeight/25)+2;
  element('line-numbers').textContent=Array.from({length:Math.max(0,Math.min(count,total-first))},(_,i)=>String(first+i+1)).join('\n');
  element('line-numbers').style.top=`${22+first*25-editor.scrollTop}px`;
}
function renderSource():void {
  editor.value=source.text;filename.value=source.name;editor.readOnly=isShared||pendingShared!==null||invalidRoute;
  filename.disabled=isShared||pendingShared!==null||invalidRoute;
  editor.scrollTop=0;editor.scrollLeft=0;editor.setSelectionRange(0,0);updateMetrics();updateButtons();
}
function saveDraft():void {
  if(isShared||pendingShared||invalidRoute||view.kind==='direct')return;
  try { localStorage.setItem(DRAFT,encodeDraft(source.snapshot()));element('draft-status').textContent='Saved locally'; }
  catch { element('draft-status').textContent='Not saved';notice('This browser could not save the draft. Download a copy to keep it.',true); }
}
function scheduleSave():void {
  clearTimeout(saveTimer);element('draft-status').textContent='Saving…';saveTimer=setTimeout(saveDraft,250);
}
function editableReplacement():boolean {
  return !hasEdits||isShared||confirm('Replace your current draft? Download it first if you want to keep a separate copy.');
}
function replaceDraft(bytes:Uint8Array,name:string):void {
  stopRun();
  loadGeneration++;loadAbort?.abort();pendingShared=null;isShared=false;hasEdits=false;invalidRoute=false;
  source.replace(bytes,name);lastPublished=undefined;element('published').hidden=true;
  if(view.kind!=='home')view.setKind('workspace');
  history.replaceState(null,'',view.kind==='home'?'/':'/workspace');renderSource();saveDraft();
}
function configureStore(value:string,persist=true):void {
  const next=storeOrigin(value.trim());
  if(next!==origin){loadGeneration++;loadAbort?.abort();}
  origin=next;
  if(build.local)element('environment').textContent=origin===build.storeOrigin?'Local workbench · local store':'Local workbench · custom store';
  element<HTMLInputElement>('store-url').value=origin;
  if(persist)try{localStorage.setItem(STORE,origin);}catch{/* Current session still works. */}
  element('connection-state').textContent='SET';
  const stats=element<HTMLAnchorElement>('store-stats');stats.href=origin+'/';stats.hidden=false;
  updateButtons();
}
async function openShared(address:string):Promise<void> {
  const parsed=parseAddress(address);
  if(!parsed||parsed.bytes>MAX_SOURCE_BYTES)throw new Error('Use a valid hash_length address within 256 KiB.');
  if(!origin){notice('Set the blob store address to open this shared source.');return;}
  requireHashing();
  if(!editableReplacement())return;
  clearTimeout(saveTimer);saveDraft();
  loadAbort?.abort();const abort=new AbortController();loadAbort=abort;
  const generation=++loadGeneration,revision=source.revision,store=origin;
  notice('Loading and verifying source…');
  const result=await loadSource(store,address,abort.signal);
  if(generation!==loadGeneration)return;
  if(source.revision!==revision){notice('Your draft changed while the source was loading. Open the address again when you are ready to replace it.');return;}
  clearTimeout(saveTimer);isShared=true;hasEdits=false;pendingShared=null;invalidRoute=false;
  stopRun();
  source.replace(result.bytes,`shared-${address.slice(0,8)}.txt`);
  lastPublished={address,origin:store,revision:source.revision};
  const direct=view.kind==='direct';
  view.setKind(direct?'direct':'program');
  history.replaceState(null,'',`/${direct?'run':'r'}/${address}`);renderSource();showPublished();
  element('draft-status').textContent='Hash & length verified';
  notice('Source verified. Press Run to begin.');
}
function showPublished():void {
  if(!lastPublished)return;
  element('published').hidden=false;element('published-address').textContent=lastPublished.address;
  element('published-state').textContent=lastPublished.revision===source.revision?'Published snapshot':'Earlier snapshot · draft has changed';
  element<HTMLAnchorElement>('open-link').href=shareURL(location.origin,lastPublished.address);
}
async function publish():Promise<void> {
  if(!origin||publishJob.busy||pendingShared)return;
  requireHashing();
  const generation=++publishGeneration,snapshot=source.snapshot(),store=origin;
  notice('Preparing a single-use proof and publishing this source snapshot…');
  const promise=publishJob.run<string>({origin:store,bytes:snapshot.bytes},65000);updateButtons();
  try {
    const address=await promise;if(generation!==publishGeneration)return;
    lastPublished={address,origin:store,revision:snapshot.revision};showPublished();
    updateMetrics();
    notice(source.isCurrent(snapshot)?'Source published. Your share link is ready.':'The earlier snapshot was published. Your newer edits remain in the editor.');
  } catch(error) { if(generation===publishGeneration)notice(`${error instanceof Error?error.message:'Publishing failed.'} If the connection failed after upload, the source may already be stored; retrying the same source is safe.`,true); }
  finally {updateButtons();}
}
type TerminalRequest = {resolve:(value:string)=>void; reject:(error:Error)=>void; cleanup:()=>void};
let terminalRequest:TerminalRequest|undefined;
function terminalInput(prompt:string,signal:AbortSignal,append:(text:string)=>void):Promise<string> {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    append(prompt);
    const form=element<HTMLFormElement>('terminal-form'),input=element<HTMLInputElement>('terminal-input');
    form.hidden=false;input.value='';if(view.mayFocusProgram)input.focus();
    const cleanup=()=>{form.hidden=true;signal.removeEventListener('abort',onAbort);if(terminalRequest?.cleanup===cleanup)terminalRequest=undefined;};
    const onAbort=()=>{cleanup();reject(new Error('Input canceled.'));};
    terminalRequest={resolve:value=>{cleanup();try{append(value+'\n');resolve(value);}catch(error){reject(error instanceof Error?error:new Error('Terminal limit reached.'));}},reject,cleanup};
    signal.addEventListener('abort',onAbort,{once:true});
  });
}
element<HTMLFormElement>('terminal-form').onsubmit=event=>{
  event.preventDefault();
  const value=element<HTMLInputElement>('terminal-input').value;
  if(value.length>RUN_LIMITS.inputChars){notice('Terminal input is too long.',true);return;}
  terminalRequest?.resolve(value);
};
async function run():Promise<void> {
  if(!runtime||pendingShared||invalidRoute)return;
  const generation=++runGeneration,snapshot=source.snapshot(),buffer=new OutputBuffer();
  runJob.cancel();
  runRevision=snapshot.revision;runAddress=lastPublished?.revision===snapshot.revision?lastPublished.address:null;
  const loader=new ContentLoader(origin,snapshot.bytes.length);
  const append=(text:string)=>{if(generation!==runGeneration)return;buffer.append(text);output.textContent=buffer.text;output.scrollTop=output.scrollHeight;if(buffer.truncated)throw new Error('Terminal output limit reached.');};
  output.textContent='';output.classList.add('has-output');element('run-state').textContent='Running…';
  const promise=runJob.run({module:runtime,bytes:snapshot.bytes},{
    input:(prompt,signal)=>terminalInput(prompt,signal,append),
    load:(address,signal)=>loader.load(address,signal),
    output:append,
    status:text=>{if(generation===runGeneration)element('run-state').textContent=text;},
  });updateButtons();updateRunBasis();notice('');
  try {
    const result=await promise;if(generation!==runGeneration)return;
    element('run-state').textContent=source.isCurrent(snapshot)?'Completed':'Completed · earlier revision';
    if(!buffer.text)output.textContent=result.summary;
  } catch(error) {
    if(generation===runGeneration){element('run-state').textContent='Stopped';output.textContent=buffer.text+`\n${error instanceof Error?error.message:'Run failed.'}`;}
  } finally {updateButtons();updateRunBasis();}
}
function stopRun():void {
  runGeneration++;runJob.cancel();element('run-state').textContent=runRevision===undefined?'No run yet':'Stopped';updateButtons();updateRunBasis();
}
function download():void {
  const snapshot=source.snapshot(),url=URL.createObjectURL(new Blob([snapshot.bytes],{type:'text/plain;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=safeName(filename.value);a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);hasEdits=false;
}
function action(fn:()=>Promise<void>|void):()=>void {return ()=>{Promise.resolve().then(fn).catch(error=>{if(error?.name!=='AbortError')notice(error instanceof Error?error.message:String(error),true);});};}

element('open-file').onclick=()=>element<HTMLInputElement>('file-input').click();
element<HTMLInputElement>('file-input').onchange=action(async()=>{
  const input=element<HTMLInputElement>('file-input'),file=input.files?.[0];input.value='';if(!file)return;
  if(file.size>MAX_SOURCE_BYTES)throw new Error('Source exceeds the 256 KiB workbench limit.');
  const revision=source.revision,bytes=new Uint8Array(await file.arrayBuffer());decodeSource(bytes);
  if(source.revision!==revision||!editableReplacement())return;
  replaceDraft(bytes,file.name);notice('File opened. Its original bytes are preserved until you edit.');
});
element('new-source').onclick=()=>{if(editableReplacement()){replaceDraft(new TextEncoder().encode('#!moss/1\n'),'untitled.moss');notice('A fresh page.');editor.focus();}};
element<HTMLSelectElement>('examples').onchange=()=>{
  const select=element<HTMLSelectElement>('examples'),value=select.value;select.value='';if(!value||!editableReplacement())return;
  const examples:Record<string,string>={first:INITIAL_SOURCE,world:WORLD_SOURCE,library:build.demo.library,graft:build.demo.program,fern:build.demo.fern,'fern-graft':build.demo.fernProgram};
  const example=examples[value];if(example===undefined)return;
  replaceDraft(new TextEncoder().encode(example),value+'.moss');notice('Example opened as a local draft.');
};
element('fork').onclick=()=>{
  let saved=false;try{saved=localStorage.getItem(DRAFT)!==null;}catch{/* No stored draft. */}
  if(saved&&!confirm('Replace your saved local draft with an editable copy of this source?'))return;
  isShared=false;hasEdits=true;view.setKind('workspace');history.replaceState(null,'','/workspace');editor.readOnly=false;filename.disabled=false;updateButtons();updateMetrics();saveDraft();notice('Editing a local copy.');editor.focus();
};
editor.oninput=()=>{
  try {source.edit(editor.value);hasEdits=true;updateMetrics();showPublished();scheduleSave();}
  catch(error){editor.value=source.text;notice(error instanceof Error?error.message:'Unable to edit.',true);}
};
let escapeTab=false;
editor.onkeydown=event=>{
  if(event.key==='Escape'){escapeTab=true;return;}
  if(event.key==='Tab'&&!event.shiftKey&&!escapeTab&&!editor.readOnly){event.preventDefault();editor.setRangeText('    ',editor.selectionStart,editor.selectionEnd,'end');editor.dispatchEvent(new Event('input'));}
  escapeTab=false;
};
editor.onscroll=lineNumbers;editor.onkeyup=updateMetrics;editor.onclick=updateMetrics;
window.addEventListener('resize',lineNumbers);
view.onExpand=()=>requestAnimationFrame(lineNumbers);
new ResizeObserver(lineNumbers).observe(editor);
filename.onchange=()=>{source.name=safeName(filename.value);filename.value=source.name;scheduleSave();};
element('download').onclick=download;
element('connect-store').onclick=action(async()=>{configureStore(element<HTMLInputElement>('store-url').value);notice('Store address set. No source has been sent.');if(pendingShared)await openShared(pendingShared);});
element<HTMLInputElement>('store-url').onkeydown=event=>{if(event.key==='Enter')element<HTMLButtonElement>('connect-store').click();};
element('load-address').onclick=action(()=>openShared(element<HTMLInputElement>('address-input').value.trim()));
element('publish').onclick=action(publish);
element('cancel-publish').onclick=()=>{publishGeneration++;publishJob.cancel();updateButtons();notice('Publishing canceled. If the upload had already started, that source snapshot may still be stored.');};
element('copy-link').onclick=action(async()=>{
  if(!lastPublished)return;const url=shareURL(location.origin,lastPublished.address);
  try{await navigator.clipboard.writeText(url);notice(build.storeOrigin===lastPublished.origin?'Share link copied.':`Share link copied. Recipients need this workbench configured for ${lastPublished.origin}.`);}
  catch{notice(`Copy this share link: ${url}`);}
});
element('hash-badge').onclick=action(async()=>{
  const address=view.identityAddress;if(!address)return;
  try{await navigator.clipboard.writeText(address);notice('Source address copied.');}
  catch{notice(`Source address: ${address}`);}
});
element('run').onclick=action(run);
element('stop-run').onclick=stopRun;
element('clear-output').onclick=()=>{output.textContent='';};
window.addEventListener('keydown',event=>{
  if(!(event.ctrlKey||event.metaKey)||!view.editorOpen||event.isComposing)return;
  if(event.key.toLowerCase()==='s'){event.preventDefault();download();}
  if(event.key==='Enter'){event.preventDefault();action(run)();}
});
window.addEventListener('pagehide',()=>{clearTimeout(saveTimer);saveDraft();publishJob.cancel();runJob.cancel();loadAbort?.abort();});
window.addEventListener('popstate',()=>location.reload());

try {
  const configured=build.local?build.storeOrigin:localStorage.getItem(STORE)||build.storeOrigin;
  if(configured)configureStore(configured,false);
} catch {if(build.storeOrigin)try{configureStore(build.storeOrigin,false);}catch{/* Editable local draft remains available. */}}
try {const route=workbenchRoute(new URL(location.href));pendingShared=route.address;view.setKind(route.kind);}catch(error){invalidRoute=true;view.setKind(location.pathname.startsWith('/run/')?'direct':'program');notice(error instanceof Error?error.message:'Invalid share link.',true);}
if(!pendingShared&&!invalidRoute)try{
  const raw=localStorage.getItem(DRAFT);
  if(raw){const draft=decodeDraft(raw);source.replace(draft.bytes,draft.name);hasEdits=true;element('draft-status').textContent='Saved locally';}
}catch{notice('The saved draft could not be restored. You can open a file or start again.',true);}
if(runtime){element('runtime-state').textContent=build.runtimeVersion??'CONNECTED';element('runtime-description').textContent='A tiny test language with a terminal, a stack, and words you can graft by hash. Sprig support will follow.';}
if(pendingShared||invalidRoute){source.replace(new Uint8Array(),'shared-source.sprig');editor.placeholder='Shared source appears here after verification.';}
renderSource();
if(build.local)element('environment').textContent='Local workbench · local store';
if(pendingShared)element('draft-status').textContent='Waiting for source';
if(pendingShared){element<HTMLInputElement>('address-input').value=pendingShared;void openShared(pendingShared).catch(error=>{if(error?.name!=='AbortError')notice(error instanceof Error?error.message:'Unable to load shared source.',true);});}
