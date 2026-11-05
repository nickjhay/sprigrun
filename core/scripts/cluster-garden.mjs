// Disposable local drill; its privileged fault adapter is NEVER a deployment entrypoint.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCluster, configuration, finish, origin, bodyOn } from '../test/barrier-local.mjs';
import { shardFor } from '../host/topology.ts';
import { actionBytes } from '../src/action.ts';
import { keyRecordBytes, signAction } from '../src/authority.ts';
import { contentAddress, textBytes, utf8 } from '../src/bytes.ts';
import { parseReceipt } from '../src/receipt.ts';
import { canonical } from '../host/archive.ts';
import { captureCluster, verifyCluster } from './cluster-recovery.mjs';
const directory=await mkdtemp(join(tmpdir(),'sprig-cluster-garden-')), live=join(directory,'live');
const firstId=crypto.randomUUID().replaceAll('-',''), finalId=crypto.randomUUID().replaceAll('-','');
let host;
async function post(path,body='',author,key) {
  const bytes=actionBytes({destination:origin+path,body:textBytes(body),author},origin);
  const result=path==='/sea'?'/sea/'+await contentAddress(textBytes(body)):path;
  const shard=await shardFor(configuration,result), signature=key?await signAction(bytes,key,origin):null;
  const receipt=await host.shard(shard).submit(bytes,signature);
  return {path:parseReceipt(textBytes(receipt),origin).result.slice(origin.length),receipt,shard};
}
try {
  host=await localCluster({directory:live});await host.controller.initialize();
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const key=await post('/sea',utf8(keyRecordBytes(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)))));
  const plot=await post('/plot/fern','',key.path,pair.privateKey);
  const source=await post('/sea',await bodyOn('fern','A fern remembers its roots.'));
  let topic;for(let i=0;i<100;i++){const p=plot.path+'/garden_'+i;if(await shardFor(configuration,p)==='moss'){topic=p;break;}}
  if(!topic)throw Error('fixture_placement');
  const publication=await post(topic,source.path+'\n',plot.path,pair.privateKey);
  const chat=await post('/chat'+publication.path,'The water between us is not a gap.',plot.path,pair.privateKey);
  await finish(host.controller,firstId);const baseDir=join(directory,'base');await mkdir(baseDir);
  const base=await captureCluster(host,baseDir,firstId);
  const last=await post(chat.path,'Another leaf, after the first photograph.',plot.path,pair.privateKey);
  await finish(host.controller,finalId);const deltaDir=join(directory,'delta');await mkdir(deltaDir);
  const bases=Object.fromEntries(Object.keys(base.files).map(n=>[n,{files:base.files[n],digest:base.plan.finals[n].footer.chain}]));
  const bundle=await captureCluster(host,deltaDir,finalId,bases);
  const checked=await verifyCluster(bundle.plan,bundle.files,bundle.digest);
  await host.dispose();host=null;await rm(live,{recursive:true,force:true});
  console.log('Saved a full cluster snapshot and its suffix; removed disposable live SQL and R2.');
  host=await localCluster({directory:live,restoring:true});
  await host.controller.restoreBegin(canonical(bundle.plan),bundle.digest,'old-writers-fenced');
  await checked.restore(host);await host.controller.fail('restore-verify:fern');
  for(;;)try{await host.controller.restoreStep(bundle.digest);}catch(e){if(!e.message.includes('injected_restore-verify:fern'))throw e;break;}
  await host.dispose();host=await localCluster({directory:live,restoring:true});
  console.log('Lost a verification reply; restarted with the same pinned plan.');
  for(let i=0;;i++){if(i>128)throw Error('restore_step_limit');if((await host.controller.restoreStep(bundle.digest)).phase==='done')break;}
  for(const name of ['fern','moss']) {
    const c=await host.shard(name).stats();if(!c.paused || c.growth.tokens!==0 || c.attempts.tokens!==0)throw Error('restore_credit');
  }
  await host.dispose();host=await localCluster({directory:live});
  for(const value of [key,plot,source,publication,chat,last]) {
    if((await host.shard(value.shard).evidence(value.path)).receipt!==value.receipt)throw Error('receipt_changed');
  }
  if(await host.shard(last.shard).latest('/chat'+publication.path)!==last.path)throw Error('head_changed');
  if((await host.controller.start(firstId)).phase!=='done')throw Error('old_barrier_reused');
  console.log('Restored the signed plot, source, publication and chat across both owners.');
  console.log('All receipts and the latest message survived; the earlier barrier is still remembered.');
  console.log('Writes remain paused. There is room for another fern.');
} finally {await host?.dispose();await rm(directory,{recursive:true,force:true});}
