// Test-only Web Worker bridge. Guest code never sees these Node facilities.
import { parentPort, workerData } from 'node:worker_threads';
import { registerHooks } from 'node:module';
if(workerData.adapter){
  registerHooks({resolve(specifier,context,next){return next(specifier===workerData.adapterURL?workerData.adapter:specifier,context);}});
}
globalThis.self={postMessage:value=>parentPort.postMessage(value),onmessage:null,location:{origin:'https://sprig.test'}};
await import(workerData.module);
parentPort.on('message',data=>self.onmessage({data}));
parentPort.postMessage({type:'ready'});
