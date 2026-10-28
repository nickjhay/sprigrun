import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { parse } from 'jsonc-parser';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function startLocalStore({ port = 0, persistPath, vars = {} } = {}) {
  const errors = [];
  const config = parse(await readFile('store/wrangler.jsonc','utf8'), errors, { allowTrailingComma:true });
  if (errors.length) throw new Error('Invalid store/wrangler.jsonc');
  const worker = await build({ entryPoints:[resolve('store',config.main)], bundle:true, format:'esm', platform:'neutral', external:['cloudflare:workers','node:crypto'], write:false });
  const bindings = Object.fromEntries(Object.entries({ ...config.vars, ...vars }).map(([key,value])=>[key,{type:'text',value:String(value)}]));
  const mf = new Miniflare({
    host:'127.0.0.1', port, ...(persistPath?{resourcePersistencePath:resolve(persistPath)}:{}),
    cf:false, log:new Log(LogLevel.ERROR), telemetry:{enabled:false},
    workers:[{config:{
      name:config.name, compatibilityDate:config.compatibility_date, compatibilityFlags:config.compatibility_flags,
      manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:worker.outputFiles[0].text}}},
      exports:{StoreCoordinator:{type:'durable-object',storage:'sqlite'}},
      env:{...bindings,BLOBS:{type:'r2',name:config.r2_buckets[0].bucket_name},
        STORE:{type:'durable-object',worker:config.name,exportName:'StoreCoordinator'}},
    }}],
  });
  try { return { mf, origin:(await mf.ready).origin, close:()=>mf.dispose() }; }
  catch(error) { await mf.dispose(); throw error; }
}
