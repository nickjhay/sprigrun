import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const run=promisify(execFile);
const hash=b=>createHash('sha256').update(b).digest('hex');

test('offline solver emits only a qualifying nonce without touching source bytes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pow-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'challenge.json');
  const c={protocol:'blob-store-upload-v1',id:'a'.repeat(64),address:hash('x')+'_1',expires_at_ms:Date.now()+600000,target:((1n<<256n)/512n-1n).toString(16).padStart(64,'0')};
  await writeFile(file,JSON.stringify(c));
  const {stdout}=await run(process.execPath,['scripts/pow.mjs',file,'100000']);
  assert.match(stdout,/^[0-9a-f]{16}\n$/);
  const actual=hash([c.protocol,c.id,c.address,String(c.expires_at_ms),c.target,stdout.trim(),''].join('\n'));
  assert.ok(BigInt('0x'+actual)<=BigInt('0x'+c.target));
});

test('offline solver fails with no stdout on exhaustion, expiry and oversized input',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pow-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'challenge.json');
  const c={protocol:'blob-store-upload-v1',id:'a'.repeat(64),address:hash('x')+'_1',expires_at_ms:Date.now()+600000,target:'0'.repeat(64)};
  for(const [contents,args,pattern] of [[JSON.stringify(c),[file,'1'],/No solution/],[JSON.stringify({...c,expires_at_ms:1}),[file],/expired/],['x'.repeat(4097),[file],/4096 bytes/],['{}',[file],/Invalid challenge/],[JSON.stringify(c),[file,'100000001'],/Usage/]]){
    await writeFile(file,contents);
    await assert.rejects(run(process.execPath,['scripts/pow.mjs',...args]),e=>{assert.equal(e.stdout,'');assert.match(e.stderr,pattern);return true;});
  }
});
