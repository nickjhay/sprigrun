import { shareSourceBytes } from '../vendor/blob-store/examples/client.ts';
const scope=self as unknown as DedicatedWorkerGlobalScope;
let started=false;
scope.onmessage=async({data})=>{
  if(started)return; started=true;
  try {
    const address=await shareSourceBytes(data.origin,new Uint8Array(data.bytes),{maxTrials:1000000,timeoutMs:30000});
    scope.postMessage({type:'done',value:address});
  } catch(error) { scope.postMessage({type:'error',message:error instanceof Error?error.message:'Publish failed.'}); }
};
