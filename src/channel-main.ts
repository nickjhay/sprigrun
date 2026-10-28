import './style.css';
import './channel-style.css';
import { serviceOrigin, keys, createChannel, appendText, readChannel, subscribe, randomHex, ChannelError } from '../channels/src/client.ts';
import { HEX256, parseCursor, type Batch, type Message } from '../channels/src/protocol.ts';
declare const __BUILD__: { channelOrigin: string; local: boolean };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = el<HTMLTextAreaElement>('message-text');
const list = el<HTMLOListElement>('messages');
let origin = serviceOrigin(__BUILD__.channelOrigin), address = '', secret = '', epoch = '', cursor: string | undefined;
let connection: ReturnType<typeof subscribe> | undefined, abort = new AbortController(), generation = 0;
let expiry = 0, busy = false, leaving = false, attempts = 0, reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let messages: Message[] = [], messageBytes = 0, retry: {text:string;id:string}|undefined;
function notice(message: string, error = false) {const n=el('channel-notice');n.textContent=message;n.classList.toggle('error',error);}
function state(text: string) {el('channel-state').textContent=text;}
function controls() {
  input.disabled=!secret||!epoch||busy;
  el<HTMLButtonElement>('send-message').disabled=input.disabled;
  el<HTMLButtonElement>('new-channel').disabled=busy;
  el<HTMLButtonElement>('reconnect-channel').disabled=!address||busy;
  el<HTMLButtonElement>('disconnect-channel').disabled=!address;
  el('channel-sharing').hidden=!address;
  el('copy-write-link').hidden=!secret;el('save-channel-key').hidden=!secret;
  el('key-note').textContent=secret?'Posting permission stays in this tab. Save the participant link or posting key before leaving.':'You have a reading link. A participant link also grants permission to post.';
}
function render() {
  const nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<100;
  list.replaceChildren();
  if(!messages.length){const item=document.createElement('li');item.className='empty-room';item.textContent='Listening for a first word.';list.append(item);}
  for(const m of messages){
    const item=document.createElement('li'),meta=document.createElement('div'),body=document.createElement('pre');
    meta.className='message-meta';meta.textContent=`#${m.seq} · ${new Date(m.at_ms).toLocaleTimeString()}`;
    body.textContent=m.text;item.append(meta,body);list.append(item);
  }
  if(nearBottom)list.scrollTop=list.scrollHeight;
}
function accept(batch: Batch) {
  epoch=batch.epoch;expiry=batch.expires_at_ms;
  for(const m of batch.messages){messages.push(m);messageBytes+=new TextEncoder().encode(m.text).byteLength;}
  while(messages.length>256||messageBytes>262144){messageBytes-=new TextEncoder().encode(messages.shift()!.text).byteLength;}
  cursor=batch.cursor;attempts=0;state('LIVE');render();controls();
  el('channel-meta').textContent=`${address.slice(0,12)}… · channel expires ${new Date(expiry).toLocaleString()}`;
  if(batch.gap)notice('Some messages expired or were pushed out before this tab received them. The conversation continues below.');
}
function disconnect() {clearTimeout(reconnectTimer);connection?.close();connection=undefined;}
function follow() {
  disconnect();if(!address||leaving||document.hidden)return;
  if(expiry&&Date.now()>=expiry){state('EXPIRED');notice('This channel has expired. Its old cursor and posting session have ended.');epoch='';controls();return;}
  const g=generation;state('CONNECTING');
  connection=subscribe(origin,address,b=>{if(g===generation)accept(b);},reason=>{
    if(g!==generation||leaving)return;state('DISCONNECTED');
    if(attempts>=5){notice(reason+' Use Reconnect when you are ready.',true);return;}
    const wait=Math.min(30000,1000*2**attempts++)+Math.random()*1000;
    reconnectTimer=setTimeout(follow,wait);notice('Connection paused. Reconnecting from the last received message…');
  },cursor);
}
async function open(nextAddress: string, nextSecret = '') {
  if(!HEX256.test(nextAddress))throw new Error('Use a 64-digit lowercase channel address.');
  if(nextSecret&&(await keys(nextSecret)).address!==nextAddress)throw new Error('The posting key does not match this address.');
  generation++;abort.abort();abort=new AbortController();disconnect();leaving=false;
  address=nextAddress;secret=nextSecret;epoch='';cursor=undefined;expiry=0;attempts=0;messages=[];messageBytes=0;retry=undefined;
  el<HTMLInputElement>('channel-address').value=address;el('room-title').textContent='A shared clearing.';
  history.replaceState(null,'','/c/'+address);render();controls();
  const g=generation, first=await readChannel(origin,address,undefined,abort.signal);
  if(g!==generation)return;
  accept(first);notice(secret?'You can read and post. Save a participant link to keep your posting permission.':'You are listening. Share the reading link to bring someone else here.');follow();
}
function invitation(value: string): {address:string;secret:string} {
  if(HEX256.test(value))return {address:value,secret:''};
  const u=new URL(value),m=/^\/c\/([0-9a-f]{64})$/.exec(u.pathname);
  if(!m)throw new Error('Use a channel address or /c/ invitation link.');
  const k=new URLSearchParams(u.hash.slice(1)).get('key')??'';
  if(k&&!HEX256.test(k))throw new Error('Invalid posting key.');
  return {address:m[1]!,secret:k};
}
function action(fn:()=>Promise<void>|void) {return ()=>{Promise.resolve().then(fn).catch(e=>{if(e?.name!=='AbortError')notice(e instanceof Error?e.message:String(e),true);});};}
el('new-channel').onclick=action(async()=>{
  if(busy)return;busy=true;controls();
  let k: {secret:string;address:string}|undefined;
  try {
    k=await keys();
    notice('Making a new channel…');await createChannel(origin,k.secret,abort.signal);await open(k.address,k.secret);
  } catch(e) {
    if(!k)throw e;
    // Preserve a newly minted key even if the creation response was lost.
    generation++;disconnect();address=k.address;secret=k.secret;epoch='';cursor=undefined;messages=[];messageBytes=0;retry=undefined;
    history.replaceState(null,'','/c/'+address);el<HTMLInputElement>('channel-address').value=address;render();
    throw e;
  } finally {busy=false;controls();}
});
el<HTMLFormElement>('join-form').onsubmit=e=>{e.preventDefault();if(busy)return;action(async()=>{const v=invitation(el<HTMLInputElement>('channel-address').value.trim());await open(v.address,v.secret);})();};
el('reconnect-channel').onclick=action(async()=>{
  disconnect();leaving=false;attempts=0;
  if(!epoch){await open(address,secret);return;}
  // An HTTP check exposes an expired/replaced incarnation before reconnecting.
  const g=generation,b=await readChannel(origin,address,cursor,abort.signal);if(g!==generation)return;accept(b);follow();
});
el('disconnect-channel').onclick=()=>{leaving=true;disconnect();state('DISCONNECTED');notice('Disconnected. This tab keeps its last cursor and posting permission.');};
input.oninput=()=>{el('message-bytes').textContent=`${new TextEncoder().encode(input.value).byteLength} / 8192 bytes`;};
el<HTMLFormElement>('message-form').onsubmit=e=>{
  e.preventDefault();if(busy||!secret||!epoch)return;
  action(async()=>{
    const text=input.value;if(!text.length)throw new Error('Write a message first.');
    if(new TextEncoder().encode(text).byteLength>8192)throw new Error('This message is longer than 8 KiB of UTF-8.');
    if(!retry||retry.text!==text)retry={text,id:randomHex()};
    const g=generation;busy=true;controls();
    try {
      await appendText(origin,secret,epoch,text,retry.id,abort.signal);
      if(g===generation){input.value='';retry=undefined;el('message-bytes').textContent='0 / 8192 bytes';notice('Message accepted.');}
    } catch(e) {if(e instanceof ChannelError&&e.status===429)throw new Error(`${e.message} Retry after about ${e.retryAfter} seconds. Your draft and retry ID are kept.`);throw e;}
    finally{busy=false;controls();input.focus();}
  })();
};
el('copy-read-link').onclick=action(()=>navigator.clipboard.writeText(location.origin+'/c/'+address).then(()=>notice('Reading link copied.')));
el('copy-write-link').onclick=action(()=>navigator.clipboard.writeText(location.origin+'/c/'+address+'#key='+secret).then(()=>notice('Participant link copied. It grants permission to post.')));
el('save-channel-key').onclick=()=>{
  if(!secret)return;const url=URL.createObjectURL(new Blob([secret+'\n'],{type:'text/plain'})),a=document.createElement('a');
  a.href=url;a.download='sprig-channel-'+address.slice(0,12)+'.key';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
function showService(){el<HTMLInputElement>('channel-service').value=origin;el<HTMLAnchorElement>('channel-stats').href=origin+'/';}
el('set-channel-service').onclick=action(()=>{
  if(busy)throw new Error('Wait for the current operation to finish.');
  const next=serviceOrigin(el<HTMLInputElement>('channel-service').value.trim());
  if(next===origin)return;
  generation++;abort.abort();abort=new AbortController();disconnect();origin=next;address='';secret='';epoch='';cursor=undefined;expiry=0;messages=[];messageBytes=0;
  history.replaceState(null,'','/channels');el<HTMLInputElement>('channel-address').value='';state('NOT CONNECTED');render();controls();showService();notice('Service changed. Open an invitation or create a channel here.');
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){disconnect();state('PAUSED');}else if(address&&!leaving)follow();});
window.addEventListener('pagehide',()=>{abort.abort();disconnect();});
showService();controls();
// Capture and remove a posting secret before making any network request. No
// secrets are put in localStorage, request URLs, logs, or the rendered history.
const initialKey=new URLSearchParams(location.hash.slice(1)).get('key')??'';
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
const initial=/^\/c\/([0-9a-f]{64})$/.exec(location.pathname);
if(initial)action(()=>open(initial[1]!,initialKey))();
