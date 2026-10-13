import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkSignIn,checkVersion,checkHarness} from '../lib/probe.mjs';
import {checkAgentsAccess} from '../lib/openai_agents.mjs';
import {DEFAULTS,validate} from '../lib/config.mjs';

const provider={account:'fixture',organization:'org-fixture',project:'proj-fixture',model:'fixture-model',environment:'openai_hosted',container_size:'small',network:{access:'disabled'},allowance:{remainingUsd:1,reservedUsd:0.1}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function delayedAccess(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const deadlines=[],calls=[],signals=[];
  t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('bounded probe expired','TimeoutError')),ms);return controller.signal;});
  const wait=signal=>new Promise((resolve,reject)=>{
    if(signal.aborted)return reject(signal.reason);
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},6000);
  });
  const http={request:async(path,{signal})=>{calls.push(path);signals.push(signal);await wait(signal);return {id:provider.model};},page:async(path,signal)=>{calls.push(path);signals.push(signal);await wait(signal);return {data:[],next:null};}};
  const advance=async ms=>{t.mock.timers.tick(ms);await flush();};
  return {http,advance,deadlines,calls,signals};
}
for(const probe of [checkSignIn,checkVersion,checkHarness])test(`${probe.name} gives serial checkpointed reads the configured shared deadline`,async t=>{
  const f=delayedAccess(t),config={execution:{deadlineMs:60000},harness:{'openai-agents':provider}};
  let verified=0;
  const sandbox=async()=>{verified++;return {evidence:{version:1,driver:'bubblewrap',filesystem:'checkout-and-runtime',network:'disabled',probe:'passed'}};};
  const pending=probe('openai-agents',config,{http:f.http,sandbox});await flush();
  await f.advance(6000);await f.advance(6000);
  assert.equal((await pending).ok,true);
  assert.deepEqual(f.deadlines,[60000]);assert.deepEqual(f.calls,['/models/fixture-model','/agents/sessions']);
  assert.equal(f.signals[0],f.signals[1]);assert.equal(f.signals[0].aborted,false);
  assert.equal(verified,probe===checkHarness?1:0);
});
test('serial access deadline is aggregate and numeric DOMException23 becomes a stable diagnostic',async t=>{
  const f=delayedAccess(t),config={execution:{deadlineMs:10000},harness:{'openai-agents':provider}};
  const pending=checkSignIn('openai-agents',config,{http:f.http});await flush();
  await f.advance(6000);await f.advance(4000);
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.detail,'EXECUTION_DEADLINE');
  assert.match(result.fix,/configured deadline/);assert.deepEqual(f.deadlines,[10000]);assert.equal(f.calls.length,2);
});
test('an earlier caller abort is preserved and a late model reply cannot authorize further reads',async t=>{
  const f=delayedAccess(t),controller=new AbortController();let resolve;
  const http={request:async(_path,{signal})=>{assert.equal(signal,controller.signal);return new Promise(done=>{resolve=done;});},page:async()=>{assert.fail('no follow-up after abort');}};
  const pending=checkSignIn('openai-agents',{execution:{deadlineMs:60000},harness:{'openai-agents':provider}},{http,signal:controller.signal});await flush();
  controller.abort();resolve({id:provider.model});
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.detail,'EXECUTION_ABORTED');assert.deepEqual(f.deadlines,[]);
});
test('standalone Agents access remains bounded without changing local or task allowance defaults',async t=>{
  const f=delayedAccess(t);const pending=checkAgentsAccess(provider,{http:f.http});await flush();await f.advance(10000);
  assert.equal((await pending).detail,'EXECUTION_DEADLINE');assert.deepEqual(f.deadlines,[10000]);
  for(const value of [10,60000,120000])assert.equal(validate({...DEFAULTS,harness:{},execution:{deadlineMs:value}}).some(problem=>problem.includes('deadlineMs')),false);
  for(const value of [9,120001,Infinity])assert.equal(validate({...DEFAULTS,harness:{},execution:{deadlineMs:value}}).some(problem=>problem.includes('deadlineMs')),true);
});
