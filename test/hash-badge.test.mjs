import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {digestToBadge,badgeToDigest,badgeRows} from '../src/hash-badge.ts';
import {workbenchRoute,sharedAddress} from '../src/document.ts';

test('50 base36 characters preserve every bit, including leading zeros and the maximum digest',()=>{
  for(const hex of ['0'.repeat(64),'0'.repeat(63)+'1','f'.repeat(64),...Array.from({length:64},()=>randomBytes(32).toString('hex'))]){
    const badge=digestToBadge(hex);assert.match(badge,/^[0-9a-z]{50}$/);assert.equal(badgeToDigest(badge),hex);
    const rows=badgeRows(hex).split('\n');assert.equal(rows.length,5);assert(rows.every(row=>row.length===10));assert.equal(rows.join(''),badge);
  }
  assert.equal(digestToBadge('0'.repeat(64)),'0'.repeat(50));
  assert.equal(digestToBadge('f'.repeat(64)),'6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtof');
});

test('badge decoding rejects overflow, mixed case, whitespace and noncanonical lengths',()=>{
  for(const text of ['z'.repeat(50),'A'.repeat(50),'0'.repeat(49),'0'.repeat(51),'0'.repeat(49)+' ','0'.repeat(49)+'_'])assert.throws(()=>badgeToDigest(text));
  for(const hex of ['F'.repeat(64),'0'.repeat(63),'0'.repeat(65),'g'.repeat(64)])assert.throws(()=>digestToBadge(hex));
});

test('home, draft overlay, legacy shared and direct views have explicit canonical routes',()=>{
  const addr='a'.repeat(64)+'_4',url=p=>new URL(p,'https://sprig.test');
  assert.deepEqual(workbenchRoute(url('/')),{kind:'home',address:null});
  assert.deepEqual(workbenchRoute(url('/workspace')),{kind:'workspace',address:null});
  assert.equal(sharedAddress(url('/workspace')),null);
  for(const prefix of ['r','w'])assert.deepEqual(workbenchRoute(url('/'+prefix+'/'+addr)),{kind:'program',address:addr});
  assert.deepEqual(workbenchRoute(url('/run/'+addr)),{kind:'direct',address:addr});
  for(const path of ['/workspace/x','/run/','/run/'+addr+'/x','/run/'+'a'.repeat(64)+'_04','/r/'+'a'.repeat(64)+'_262145','/r/not-a-hash'])assert.throws(()=>workbenchRoute(url(path)));
});
