import { buildWorkbench } from './build.mjs';
import { serveStatic } from './static-server.mjs';
const args=process.argv.slice(2);
const uiOnly=args.includes('--ui-only');
function option(name,fallback){const i=args.indexOf(name);return i<0?fallback:args[i+1];}
function port(value){const n=Number(value);if(!Number.isInteger(n)||n<1||n>65535)throw new Error('Invalid port');return n;}
const webPort=port(option('--port',process.env.PORT??5173));
const storePort=port(option('--store-port',8787));
const channelPort=port(option('--channel-port',8788));
let store, channels, server, stopping=false;
async function stop(){if(stopping)return;stopping=true;server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await channels?.close();await store?.close();}
try {
  let demo;
  if(!uiOnly){
    // Keep the UI path free of even importing Miniflare/workerd: older Macs can
    // run the editor and browser interpreter without starting service emulation.
    const {startLocalStore}=await import('./local-store.mjs');
    const {seed}=await import('./seed.mjs');
    const {startLocalChannels}=await import('../channels/scripts/local.mjs');
    store=await startLocalStore({port:storePort,persistPath:'.local/store'});
    demo=await seed(store.origin);
    channels=await startLocalChannels({port:channelPort,persistPath:'.local/channels'});
  }
  await buildWorkbench({directory:'.dev-dist',origin:store?.origin??'',channelOrigin:channels?.origin??`http://127.0.0.1:${channelPort}`,local:true});
  server=await serveStatic({directory:'.dev-dist',port:webPort,host:option('--host','127.0.0.1')});
  console.log(`\nWorkbench: http://localhost:${webPort}/\nDraft overlay: http://localhost:${webPort}/workspace`);
  if(uiOnly){
    console.log('\nChoose “A little fern” from Examples, then Run.\nEditing, terminal I/O and browser draft saving work here.\nPublishing and hash imports need a store; channels need their service.\nNo backend is started or seeded. Ctrl+C stops the preview.\n');
  }else{
    console.log(`Channels: http://localhost:${webPort}/channels\nLocal blob store: ${store.origin}/\nLocal channel service: ${channels.origin}/\nA little fern: http://localhost:${webPort}/r/${demo.fernProgramAddress}\nFern without editor: http://localhost:${webPort}/run/${demo.fernProgramAddress}\nGrafted postcard: http://localhost:${webPort}/r/${demo.programAddress}\nDirect view: http://localhost:${webPort}/run/${demo.programAddress}\n\nEverything here is local. Data persists in .local/store/ and .local/channels/. Ctrl+C stops all three servers.\n`);
  }
  for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>{void stop().then(()=>process.exit(0));});
} catch(error) {await stop();throw error;}
