import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeGh} from '../lib/gh.mjs';
import { resolveCredential } from '../lib/credential.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('branch preflight preserves a selected token-file refusal before calling gh', async t => {
  const home = mkdtempSync(join(tmpdir(), 'branch-credential-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const gh = makeGh({
    credential: () => resolveCredential({ github_token_file: join(home, 'missing-token') }, { env: { GH_TOKEN: 'broader-fixture-token' }, exec: async () => 'broader-fixture-token' }),
    exec: async () => { calls++; throw new Error('gh should not run'); },
  });
  await assert.rejects(gh.branchExists('acme/widget', 'main'), error => {
    assert.equal(error.code, 'NO_CREDENTIAL');
    assert.equal(error.reason, 'configured-token-file-unavailable');
    assert.match(error.message, /Restore that private token file.*restart the daemon/);
    assert.doesNotMatch(error.message, /broader-fixture-token/);
    return true;
  });
  await assert.rejects(gh.fileAt('acme/widget', 'docs/prd.md', 'main'), { code: 'NO_CREDENTIAL', reason: 'configured-token-file-unavailable' });
  assert.equal(calls, 0);
});

test('branch lookup retains exact credential, standard deadline and encoded branch route',async()=>{
  let called=0;
  const gh=makeGh({credential:async()=>({token:'opaque-fixture-credential'}),exec:async(cmd,args,options)=>{
    called++;assert.equal(cmd,'gh');assert.deepEqual(args,['api','repos/acme/widget/branches/release%2Fone','--jq','{name: .name}']);
    assert.equal(options.env.GH_TOKEN,'opaque-fixture-credential');assert.equal(options.timeout,60000);
    return {stdout:JSON.stringify({name:'release/one'})};
  }});
  assert.equal(await gh.branchExists('acme/widget','release/one'),true);assert.equal(called,1);
});
test('only completed HTTP404 remains an absent branch',async()=>{
  const gh=makeGh({exec:async()=>{throw Object.assign(new Error('gh failed'),{code:1,stderr:'gh: Not Found (HTTP 404)'});}});
  assert.equal(await gh.branchExists('acme/widget','main'),false);
});
for(const [kind,stderr,code] of [['tls','x509: certificate signed by unknown authority',1],['dns','lookup api.github.com: no such host',1],['process','spawn gh ENOENT','ENOENT'],['authorization','gh: Resource not accessible (HTTP 403)',1],['timeout','request timed out',null]])test(`branch ${kind} error remains actionable, bounded and credential-redacted`,async()=>{
  const token='opaque-fixture-credential';
  const gh=makeGh({credential:async()=>({token}),exec:async()=>{throw Object.assign(new Error('gh failed'),{code,stderr:`${stderr} ${token} Bearer another-secret ${'x'.repeat(3000)}`});}});
  await assert.rejects(gh.branchExists('acme/widget','main'),error=>{
    assert.equal(error.code,'GH_BRANCH_LOOKUP');assert.ok(error.message.includes(stderr));assert.ok(error.message.length<1300);
    assert.ok(!error.message.includes(token));assert.ok(!error.message.includes('another-secret'));assert.match(error.message,/\[redacted\]/);return true;
  });
});
