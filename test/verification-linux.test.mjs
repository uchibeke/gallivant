import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkVerificationSandbox} from '../lib/execution_result.mjs';

// Run inside the production Linux image with namespaces enabled. This executes
// the real boundary and its filesystem, Git, network and privilege probes.
test('Linux verification enforces isolation and drops all capabilities', {skip:process.platform!=='linux'||process.env.GALLIVANT_NATIVE_SANDBOX_TEST!=='1'}, async()=>{
  const result=await checkVerificationSandbox();
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.evidence.driver,'bubblewrap');
  assert.equal(result.evidence.probe,'passed');
});
