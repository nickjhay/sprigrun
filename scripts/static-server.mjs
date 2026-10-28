import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.wasm':'application/wasm'};
export async function serveStatic({ directory, port, host='127.0.0.1' }) {
  const root=resolve(directory);
  const headers=await readFile('public/_headers','utf8');
  const csp=headers.match(/Content-Security-Policy: ([^\n]+)/)[1];
  const server=createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
      let path=new URL(req.url,'http://localhost').pathname;
      if(path==='/'||path==='/workspace'||/^\/(r|w|run)\/[^/]+$/.test(path))path='/index.html';
      if(path==='/channels'||/^\/c\/[0-9a-f]{64}$/.test(path))path='/channels.html';
      const file=resolve(root,'.'+decodeURIComponent(path));
      if(!file.startsWith(root+'/')||!(await stat(file)).isFile()){res.writeHead(404).end();return;}
      res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store',
        'Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
      res.end(req.method==='HEAD'?undefined:await readFile(file));
    } catch {res.writeHead(404).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return server;
}
