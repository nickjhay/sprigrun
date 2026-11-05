import test from 'node:test';
import assert from 'node:assert/strict';
import { topology, dividedPolicy } from '../host/topology.ts';
import { DEFAULT_POLICY } from '../host/policy.ts';
const make = n => ({ format:'sprig-topology/1', id:'a'.repeat(32), revision:'0', origin:'https://sprig.run',
  shards:Object.fromEntries(Array.from({length:n},(_,i)=>['shard_'+i,true])), budget:DEFAULT_POLICY });
test('static shard capacities and refill rates sum exactly, including every integer remainder', () => {
  for (const n of [1,2,3,7,16]) {
    const t = topology(make(n)), parts = Object.keys(t.shards).map(name=>dividedPolicy(t,name));
    for (const bucket of ['growth','burst','attempts']) for (const field of ['capacity','refill'])
      assert.equal(parts.reduce((sum,p)=>sum+p[bucket][field],0), DEFAULT_POLICY[bucket][field]);
    assert.deepEqual(parts[0].sourceBytes,DEFAULT_POLICY.sourceBytes);
  }
  assert.deepEqual(dividedPolicy(topology(make(1)),'shard_0'), DEFAULT_POLICY);
});
test('invalid, undersized or ambiguous topology fails before shard initialization', () => {
  for (const t of [{...make(2),shards:{}}, make(17), {...make(2),shards:{'not-a-name':true}},
    {...make(2),unknown:true}, {...make(2),shards:{a:false}}, {...make(2),id:'short'},
    {...make(2),budget:{...DEFAULT_POLICY,attempts:{capacity:1,refill:1,periodMs:1}}}])
    assert.throws(()=>topology(t));
  assert.throws(()=>dividedPolicy(make(2),'absent'),/unknown_shard/);
});
