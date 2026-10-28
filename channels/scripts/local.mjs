import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { parse } from 'jsonc-parser';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function startLocalChannels({port=0,persistPath,vars={}}={}) {
  const errors=[],cfg=parse(await readFile(root+'wrangler.jsonc','utf8'),errors,{allowTrailingComma:true});
  if(errors.length)throw new Error('Invalid channels/wrangler.jsonc');
  const worker=await build({entryPoints:[resolve(root,cfg.main)],bundle:true,format:'esm',platform:'neutral',external:['cloudflare:workers','node:crypto'],write:false});
  const env=Object.fromEntries(Object.entries({...cfg.vars,...vars}).map(([k,v])=>[k,{type:'text',value:String(v)}]));
  const mf=new Miniflare({host:'127.0.0.1',port,...(persistPath?{resourcePersistencePath:resolve(persistPath)}:{}),cf:false,log:new Log(LogLevel.ERROR),telemetry:{enabled:false},
    workers:[{config:{name:cfg.name,compatibilityDate:cfg.compatibility_date,compatibilityFlags:cfg.compatibility_flags,
      manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:worker.outputFiles[0].text}}},
      exports:{ChannelHub:{type:'durable-object',storage:'sqlite'}},
      env:{...env,HUB:{type:'durable-object',worker:cfg.name,exportName:'ChannelHub'}},
    }}]});
  try {return {mf,origin:(await mf.ready).origin,close:()=>mf.dispose()};}
  catch(error){await mf.dispose();throw error;}
}
