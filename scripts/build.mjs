import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { storeOrigin } from '../src/document.ts';
import { runtimeURL } from '../src/runtime-contract.ts';
import { demoSources } from '../src/examples.ts';
export async function buildWorkbench({ directory = 'dist', origin, channelOrigin, local = false } = {}) {
  const config = JSON.parse(await readFile('workbench.config.json','utf8'));
  if (!config || typeof config !== 'object') throw new Error('Invalid workbench.config.json');
  config.storeOrigin = origin ?? config.storeOrigin;
  config.storeOrigin = config.storeOrigin ? storeOrigin(config.storeOrigin) : '';
  config.channelOrigin = storeOrigin(channelOrigin ?? config.channelOrigin ?? 'https://channels.sprig.run');
  if (config.runtimeVersion != null && (typeof config.runtimeVersion !== 'string' || config.runtimeVersion.length > 100)) throw new Error('Invalid runtime version label');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory + '/assets', { recursive: true });
  await cp('public', directory, { recursive: true });
  const outputFor = (meta, entry) => {
    const path = Object.entries(meta.outputs).find(([path,out]) => out.entryPoint === entry && path.endsWith('.js'))?.[0];
    if (!path) throw new Error('Missing build output: ' + entry);
    return '/' + path.slice(directory.length + 1);
  };
  if (config.runtimeModule === 'moss/1') {
    const adapter = await build({ entryPoints:['src/moss/adapter.ts'], outdir:directory+'/runtime', entryNames:'moss-[hash]', bundle:true, format:'esm', platform:'browser', target:'es2023', metafile:true });
    config.runtimeModule = outputFor(adapter.metafile, 'src/moss/adapter.ts');
  } else if (config.runtimeModule) {
    config.runtimeModule = new URL(runtimeURL(config.runtimeModule,'https://sprig.run')).pathname;
    await access('public'+config.runtimeModule);
  }
  const workers = await build({ entryPoints:['src/publish-worker.ts','src/runtime-worker.ts'], outdir:directory+'/assets', entryNames:'[name]-[hash]', bundle:true, format:'esm', platform:'browser', target:'es2023', metafile:true });
  const settings = { ...config, local, demo:await demoSources(), publishWorker:outputFor(workers.metafile,'src/publish-worker.ts'), runtimeWorker:outputFor(workers.metafile,'src/runtime-worker.ts') };
  const main = await build({ entryPoints:['src/main.ts'], outdir:directory+'/assets', entryNames:'[name]-[hash]', bundle:true, format:'esm', platform:'browser', target:'es2023', metafile:true, define:{ __BUILD__:JSON.stringify(settings) } });
  const js = outputFor(main.metafile,'src/main.ts');
  const css = '/' + Object.keys(main.metafile.outputs).find(p=>p.endsWith('.css')).slice(directory.length+1);
  const html = (await readFile('index.html','utf8')).replace('<!-- BUILD_ASSETS -->',`<link rel="stylesheet" href="${css}"><script type="module" src="${js}"></script>`);
  await writeFile(directory+'/index.html',html);
  const channel = await build({ entryPoints:['src/channel-main.ts'], outdir:directory+'/assets', entryNames:'[name]-[hash]', bundle:true, format:'esm', platform:'browser', target:'es2023', metafile:true, define:{ __BUILD__:JSON.stringify(settings) } });
  const channelJs = outputFor(channel.metafile,'src/channel-main.ts');
  const channelCss = '/' + Object.keys(channel.metafile.outputs).find(p=>p.endsWith('.css')).slice(directory.length+1);
  await writeFile(directory+'/channels.html',(await readFile('channels.html','utf8')).replace('<!-- BUILD_ASSETS -->',`<link rel="stylesheet" href="${channelCss}"><script type="module" src="${channelJs}"></script>`));
  return settings;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWorkbench(); console.log('Built production workbench in dist/');
}
