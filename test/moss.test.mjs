import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret, MOSS_LIMITS } from '../src/moss/interpreter.ts';
import { addressOf } from '../src/document.ts';
import { demoSources } from '../src/examples.ts';
const bytes=text=>new TextEncoder().encode(text);
async function run(code, overrides={}) {
  let output='';const prompts=[];
  const result=await interpret(bytes('#!moss/1\n'+code),{print:t=>output+=t,input:async p=>{prompts.push(p);return 'Ada';},load:async()=>{throw new Error('No store');},...overrides});
  return {...result,output,prompts};
}
test('arithmetic, words and a terminal conversation compose through the stack',async()=>{
  const r=await run('"Name? " input "Hello, " swap + print : square dup * ; 7 square print 10 3 - 2 / print');
  assert.equal(r.output,'Hello, Ada\n49\n3.5\n');assert.deepEqual(r.prompts,['Name? ']);assert.deepEqual(r.stack,[]);
});
test('string escapes, Unicode code points and comments stay data',async()=>{
  const r=await run('"😀a" reverse print "😀a" len print "a\\nb" print # comment\n "<script>alert(1)</script>" print');
  assert.equal(r.output,'a😀\n2\na\nb\n<script>alert(1)</script>\n');
});
test('grafted library runs once and adds words in a deterministic shared namespace',async()=>{
  const lib=bytes('#!moss/1\n: square dup * ; "loaded" print'),address=await addressOf(lib);let loads=0;
  const r=await run(`"${address}" graft "${address}" graft 8 square print`,{load:async a=>{assert.equal(a,address);loads++;return lib;}});
  assert.equal(r.output,'loaded\n64\n');assert.equal(loads,1);
});
test('source versions and invalid definitions fail explicitly',async()=>{
  await assert.rejects(interpret(bytes('print("hello")'),{}),/Moss needs/);
  for(const code of [': print 1 ;',': x 1',': x : y ; ;', ';', '"unfinished', '"bad\\q"', ': x 1 ; : x 2 ;'])await assert.rejects(run(code));
});
test('no ambient JavaScript, arithmetic coercion, nonfinite values or zero division',async()=>{
  for(const code of ['fetch','globalThis','constructor','eval','"1" 2 +','1 0 /','1 0 %','1e999','1e308 1e308 *','"Infinity" number'])await assert.rejects(run(code));
});
test('recursion, stack and string growth are bounded',async()=>{
  await assert.rejects(run(': forever forever ; forever'),/depth limit/);
  await assert.rejects(run('1 '.repeat(257)),/Stack limit/);
  await assert.rejects(run(JSON.stringify('x'.repeat(9000))+' dup +'),/String limit/);
  await assert.rejects(run('drop'),/stack is empty/);
});
test('instruction budget spans word calls, not just the root file',async()=>{
  await assert.rejects(run(': step '+ '1 drop '.repeat(32)+' ; '+ 'step '.repeat(2000)),/Instruction limit/);
});
test('input and output budgets cannot be renewed by repeated calls',async()=>{
  await assert.rejects(run(('"?" input drop ').repeat(17)),/Input request limit/);
  await assert.rejects(run(('1 print ').repeat(1025)),/Output limit/);
  await assert.rejects(run('"?" input',{input:async()=> 'x'.repeat(MOSS_LIMITS.stringChars+1)}),/String limit/);
});
test('graft requires a bounded canonical content address and a supported source header',async()=>{
  for(const a of ['https://evil.test/code','A'.repeat(64)+'_1','a'.repeat(64)+'_01','a'.repeat(64)+'_262145'])await assert.rejects(run(JSON.stringify(a)+' graft'),/graft needs/);
  await assert.rejects(run('"'+'a'.repeat(64)+'_1" graft',{load:async()=>bytes('bad')}),/Moss needs/);
});

test('the fern unfurls through three inputs with the same result locally and by graft',async()=>{
  const demo=await demoSources(),runs=[];
  for(const source of [demo.fern,demo.fernProgram]){
    let output='',loads=0;const prompts=[],answers=['  Koru  ','',''];
    const result=await interpret(bytes(source),{
      print:text=>output+=text,
      input:async prompt=>{prompts.push(prompt);assert.ok(answers.length);return answers.shift();},
      load:async address=>{assert.equal(address,demo.fernLibraryAddress);loads++;return bytes(demo.fernLibrary);},
    });
    assert.deepEqual(result.stack,[]);assert.equal(answers.length,0);
    assert.deepEqual(prompts,['Name your fern: ','Press Enter to wake the first fronds. ','Press Enter to let it unfurl. ']);
    assert.match(output,/Planting Koru\./);
    assert.ok(output.includes('╱╱╱╱╱     │     ╲╲╲╲╲'));
    assert.ok(output.endsWith('Koru is here. The morning can take its time.\n'));
    runs.push({output,loads});
  }
  assert.equal(runs[0].output,runs[1].output);
  assert.deepEqual(runs.map(r=>r.loads),[0,1]);
});
