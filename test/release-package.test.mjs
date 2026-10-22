import { CORE_VERSION } from '../lib/task_delivery_contract.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { RELEASE_CHECKS, releaseIdentity, evaluateRelease, releasePreflight, verifyReleasePayload, readReleaseJson, assembleRelease } from '../lib/release_package.mjs';
import { packagingControlInventory, packagingControl, runtimeFile } from '../lib/plugin_package.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function candidate() {
  const manifest = { classification: 'public-candidate-unqualified', sourceVerified: true, uncommittedPayload: [], coreSha256: hash('core'), dependencyLockSha256: hash('lock'), hashes: { plugin: hash('plugin'), operations: hash('tools'), runtime: hash('runtime') }, schemaHashes: {}, payloadHashes: {}, packagingControlHashes: {}, endpoint: 'https://aport.io/api/task-delivery/mcp' };
  const deployment = { revision: 'observed-revision', configurationSha256: hash('config'), endpoint: manifest.endpoint };
  return { manifest, deployment };
}
function observed(input) {
  const identity = releaseIdentity(input.manifest, input.deployment);
  return { version: 1, checks: Object.fromEntries(Object.entries(RELEASE_CHECKS).map(([id, rule]) => [id, {
    kind: 'live', status: 'passed', at: '2026-10-01T00:00:00Z', bindings: Object.fromEntries(rule.scopes.map(scope => [scope, identity[scope]])),
    observations: Object.fromEntries(rule.cases.map(name => [name, `audit/${id}.json#${name}`])),
  }])), states: { codeMerged: { at: '2026-10-01T00:00:00Z', pointer: 'audit/merge.json', identity } } };
}

test('missing evidence and fixtures never qualify a release', () => {
  const input = candidate();
  let result = evaluateRelease(input);
  assert.equal(result.status, 'needs-human');
  assert.equal(result.rerun.length, Object.keys(RELEASE_CHECKS).length);
  for (const kind of ['fixture', 'offline', 'live']) {
    const evidence = observed(input);
    evidence.checks.host.kind = kind;
    if (kind === 'live') delete evidence.checks.host.observations.correction;
    assert.equal(evaluateRelease({ ...input, evidence }).states.submissionReady, false);
  }
  input.manifest.classification = 'internal-development-fixture; not-installed-host-evidence';
  assert.equal(evaluateRelease({ ...input, evidence: observed(input) }).states.liveQualified, false);
});

test('evidence invalidation is scoped to actual candidate changes', () => {
  const input = candidate(), evidence = observed(input);
  assert.equal(evaluateRelease({ ...input, evidence }).status, 'submission-ready');
  input.manifest.hashes.plugin = hash('edited screenshot or skill');
  let result = evaluateRelease({ ...input, evidence });
  assert.equal(result.checks.host.status, 'stale');
  assert.equal(result.checks.agents.status, 'passed');
  assert.equal(result.checks.cloud.status, 'passed');
  assert.equal(result.checks.scans.status, 'stale');
  input.deployment.revision = 'new-revision';
  result = evaluateRelease({ ...input, evidence });
  assert.equal(result.checks.agents.status, 'stale');
  assert.equal(result.checks.integration.status, 'passed');
  input.manifest.coreSha256 = hash('new code');
  assert.equal(evaluateRelease({ ...input, evidence }).checks.integration.status, 'stale');
});

test('current bound live failures and blocks retain their outcomes', () => {
  for (const status of ['failed', 'blocked']) {
    const input = candidate(), evidence = observed(input);
    evidence.checks.host.status = status;
    evidence.checks.host.observations = { installedCandidate: 'audit/host.json#attempt' };
    const result = evaluateRelease({ ...input, evidence });
    assert.equal(result.checks.host.status, status);
    assert.equal(result.blockers.find(b => b.id === 'host').status, status);
    assert.equal(result.states.liveQualified, false);
    assert.equal(result.states.submissionReady, false);
    assert.ok(result.rerun.includes('host'));
    for (const kind of ['offline', 'fixture']) {
      evidence.checks.host.kind = kind;
      assert.equal(evaluateRelease({ ...input, evidence }).checks.host.status, 'unverified');
    }
    evidence.checks.host.kind = 'live';
    evidence.checks.host.at = '2999-01-01';
    assert.equal(evaluateRelease({ ...input, evidence }).checks.host.status, 'unverified');
    evidence.checks.host.at = '2026-10-01';
    input.manifest.hashes.plugin = hash('changed plugin');
    assert.equal(evaluateRelease({ ...input, evidence }).checks.host.status, 'stale');
  }
});

test('runtime configuration changes invalidate deployment-dependent evidence only', () => {
  const input = candidate();
  input.manifest.resource = { uri: 'ui://task-delivery/app', domain: 'https://aport.io', connectDomains: [], resourceDomains: [] };
  input.manifest.requirements = { node: '>=22' };
  input.manifest.exports = { '.': './lib/index.mjs' };
  Object.assign(input.manifest, { coreVersion: CORE_VERSION, operationVersion: 1, taskVersion: 1, executionVersion: 1 });
  const evidence = observed(input), identity = releaseIdentity(input.manifest, input.deployment);
  const changes = [
    m => { m.resource.uri = 'ui://task-delivery/next'; },
    m => { m.resource.domain = 'https://app.aport.io'; },
    m => { m.resource.connectDomains = ['https://api.aport.io']; },
    m => { m.resource.resourceDomains = ['https://assets.aport.io']; },
    m => { m.requirements.node = '>=24'; },
    m => { m.exports['.'] = './lib/next.mjs'; },
    ...['coreVersion', 'operationVersion', 'taskVersion', 'executionVersion'].map(key => m => { m[key] = 'next'; }),
  ];
  for (const change of changes) {
    const manifest = structuredClone(input.manifest); change(manifest);
    const result = evaluateRelease({ manifest, deployment: input.deployment, evidence });
    for (const scope of ['core', 'tools', 'plugin']) assert.equal(result.identity[scope], identity[scope]);
    assert.notEqual(result.identity.deployment, identity.deployment);
    assert.equal(result.checks.integration.status, 'passed');
    const affected = Object.keys(RELEASE_CHECKS).filter(id => id !== 'integration');
    assert.deepEqual(result.rerun, affected);
    for (const id of affected) assert.equal(result.checks[id].status, 'stale', id);
    assert.equal(result.status, 'needs-human');
    assert.equal(result.states.codeMerged, false);
    assert.equal(result.states.liveQualified, false);
    assert.equal(result.states.submissionReady, false);
  }
  // Runtime serialization/provenance changes do not change functional settings.
  input.manifest.sourceCommit = 'audit-only commit';
  input.manifest.hashes.runtime = hash('runtime serialized with new provenance');
  input.manifest.resource = Object.fromEntries(Object.entries(input.manifest.resource).reverse());
  assert.deepEqual(releaseIdentity(input.manifest, input.deployment), identity);
  assert.equal(evaluateRelease({ ...input, evidence }).status, 'submission-ready');
});

test('record-only changes preserve qualification and never infer publication', () => {
  const input = candidate(), evidence = observed(input);
  input.manifest.sourceCommit = 'new audit-only commit';
  input.deployment = Object.fromEntries(Object.entries(input.deployment).reverse());
  const result = evaluateRelease({ ...input, evidence });
  assert.equal(result.status, 'submission-ready');
  for (const state of ['submitted', 'approved', 'published']) assert.equal(result.states[state], false);
  delete evidence.states;
  assert.equal(evaluateRelease({ ...input, evidence }).status, 'needs-human');
});

test('packaging controls are source inputs and invalidate core evidence', () => {
  for (const path of ['.npmignore', '.gitignore', '.npmrc', 'lib/nested/.npmignore', 'templates/plugin/.gitignore', 'templates/plugin/.npmrc', 'docs/.npmignore']) {
    assert.equal(packagingControl(path), true);
    assert.equal(runtimeFile(path), false, 'controls must not enter the runtime payload');
  }
  const input = candidate(), evidence = observed(input);
  input.manifest.packagingControlHashes = { '.npmignore': hash('changed controls') };
  const result = evaluateRelease({ ...input, evidence });
  for (const id of ['integration', 'deployment', 'agents', 'cloud', 'host', 'recovery', 'reviewer', 'scans', 'upgrade']) assert.equal(result.checks[id].status, 'stale', id);
  for (const id of ['publisher', 'media']) assert.equal(result.checks[id].status, 'passed', id);
  assert.equal(result.states.submissionReady, false);
});

test('malformed, private, future and boolean observations fail closed', () => {
  const input = candidate();
  for (const edit of [e => { e.version = 2; }, e => { e.reviewer_instructions = 'private'; }, e => { e.checks.host.secret = 'private'; }, e => { e.states.published = true; }, e => { e.states.codeMerged.identity.core = 'Bearer private_test_secret'; }]) {
    const evidence = observed(input); edit(evidence);
    assert.throws(() => evaluateRelease({ ...input, evidence }));
  }
  for (const value of [true, '', 'Bearer private_test_secret']) {
    const evidence = observed(input); evidence.checks.host.observations.panel = value;
    assert.throws(() => evaluateRelease({ ...input, evidence }), /Invalid host observation/);
  }
  const evidence = observed(input); evidence.checks.host.at = '2999-01-01';
  assert.equal(evaluateRelease({ ...input, evidence }).checks.host.status, 'unverified');
});

test('preflight keeps known setup and reports concrete missing prerequisites', () => {
  const result = releasePreflight({}, { target: 'audit/target.json' });
  assert.equal(result.status, 'needs-human');
  assert.equal(result.submissionReady, false);
  assert.ok(!result.blockers.some(b => b.id === 'target'));
  assert.ok(result.blockers.some(b => b.id === 'executionAllowance' && b.next.includes('shared USD 10')));
  assert.throws(() => releasePreflight({}, { apiKey: 'private' }));
});

test('payload verification rejects tampering, source additions and symlinks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), out = join(dir, 'out'); mkdirSync(source); mkdirSync(out); mkdirSync(join(source, 'lib'));
  writeFileSync(join(source, 'lib/core.mjs'), 'export const version = 1;');
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture'], { cwd: source });
  const { manifest } = candidate(); manifest.coreArtifact = 'core.tgz';
  for (const [file, key] of [['core.tgz', null], ['aport-task-delivery.zip', 'plugin'], ['runtime.json', 'runtime'], ['operations.json', 'operations']]) {
    const bytes = key === 'runtime' ? '{}' : file;
    writeFileSync(join(out, file), bytes); if (key) manifest.hashes[key] = hash(bytes); else manifest.coreSha256 = hash(bytes);
  }
  const handoffFiles = ['listing.md', 'release-notes.md', 'review-cases.json', 'START-HERE.md', 'RUNTIME.md'];
  manifest.handoffHashes = Object.fromEntries(handoffFiles.map(file => {
    writeFileSync(join(out, file), file); return [file, hash(file)];
  }));
  mkdirSync(join(out, 'plugin'));
  writeFileSync(join(out, 'plugin/plugin.json'), 'plugin');
  manifest.assetHashes = { 'plugin.json': hash('plugin') };
  manifest.payloadHashes = { 'lib/core.mjs': hash(readFileSync(join(source, 'lib/core.mjs'))) };
  assert.equal(verifyReleasePayload(out, manifest, { sourceRoot: source }), true);
  const changedRuntime = JSON.stringify({ resource: { uri: 'ui://task-delivery/changed' } });
  writeFileSync(join(out, 'runtime.json'), changedRuntime);
  assert.throws(() => verifyReleasePayload(out, { ...manifest, hashes: { ...manifest.hashes, runtime: hash(changedRuntime) } }, { sourceRoot: source }), /Runtime configuration differs/);
  writeFileSync(join(out, 'runtime.json'), '{}');
  for (const file of [...handoffFiles, 'plugin/plugin.json']) {
    const original = readFileSync(join(out, file));
    for (const replacement of ['tampered', '']) {
      writeFileSync(join(out, file), replacement);
      assert.throws(() => verifyReleasePayload(out, manifest, { sourceRoot: source }), /Candidate bytes changed/);
    }
    rmSync(join(out, file));
    assert.throws(() => verifyReleasePayload(out, manifest, { sourceRoot: source }), /ENOENT/);
    writeFileSync(join(out, file), original);
  }
  for (const file of handoffFiles) {
    const incomplete = structuredClone(manifest); delete incomplete.handoffHashes[file];
    assert.throws(() => verifyReleasePayload(out, incomplete, { sourceRoot: source }), /Candidate bytes changed/);
  }
  const legacy = structuredClone(manifest); delete legacy.handoffHashes;
  assert.throws(() => verifyReleasePayload(out, legacy, { sourceRoot: source }), /Incomplete handoff hashes/);
  for (const file of ['evidence.json', 'qualification.json']) writeFileSync(join(out, file), '{"updated":true}');
  assert.equal(verifyReleasePayload(out, manifest, { sourceRoot: source }), true);
  const legacyControls = structuredClone(manifest); delete legacyControls.packagingControlHashes;
  assert.throws(() => verifyReleasePayload(out, legacyControls, { sourceRoot: source }), /packaging-control inventory/);
  const commitControls = () => {
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Update packaging fixture'], { cwd: source });
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }), '');
  };
  for (const path of ['.npmignore', '.gitignore', '.npmrc', 'lib/nested/.npmignore', 'lib/nested/.gitignore', 'lib/nested/.npmrc', 'templates/plugin/.npmignore', 'docs/.gitignore']) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), '# original operator control\n'); commitControls();
    assert.throws(() => verifyReleasePayload(out, manifest, { sourceRoot: source }), /Committed packaging controls changed/, `added ${path}`);
    const baseline = { ...manifest, packagingControlHashes: packagingControlInventory(source, 'HEAD') };
    assert.deepEqual(baseline.packagingControlHashes, { [path]: hash('# original operator control\n') });
    assert.equal(verifyReleasePayload(out, baseline, { sourceRoot: source }), true);
    writeFileSync(join(source, path), '# changed operator control\n');
    assert.throws(() => verifyReleasePayload(out, baseline, { sourceRoot: source }), /Packaging control changed/, `dirty ${path}`);
    commitControls();
    assert.throws(() => verifyReleasePayload(out, baseline, { sourceRoot: source }), /Committed packaging controls changed/, `modified ${path}`);
    const changedControls = { ...manifest, packagingControlHashes: packagingControlInventory(source, 'HEAD') };
    rmSync(join(source, path)); commitControls();
    assert.throws(() => verifyReleasePayload(out, changedControls, { sourceRoot: source }), /Committed packaging controls changed/, `removed ${path}`);
    assert.equal(verifyReleasePayload(out, manifest, { sourceRoot: source }), true);
  }
  writeFileSync(join(source, 'lib/new.mjs'), '// newly introduced code');
  assert.throws(() => verifyReleasePayload(out, manifest, { sourceRoot: source }), /Uncommitted/);
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Additional fixture'], { cwd: source });
  assert.throws(() => verifyReleasePayload(out, manifest, { sourceRoot: source }), /paths changed/);
  writeFileSync(join(out, 'aport-task-delivery.zip'), 'tampered');
  assert.throws(() => verifyReleasePayload(out, manifest, { sourceRoot: source }), /bytes changed/);
  rmSync(join(out, 'core.tgz')); symlinkSync(join(out, 'runtime.json'), join(out, 'core.tgz'));
  assert.throws(() => verifyReleasePayload(out, manifest, { sourceRoot: source }), /symlinks/);
  manifest.coreArtifact = '../secret';
  assert.throws(() => verifyReleasePayload(out, manifest, { sourceRoot: source }), /Unsafe/);
});

test('bounded JSON and opt-in commands cannot silently start live work', t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-json-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'record.json'); writeFileSync(file, ' '.repeat(1048577));
  assert.throws(() => readReleaseJson(file), /1 MiB/);
  for (const args of [[], ['--host'], ['--execute', '--backend', 'openai-agents']]) {
    const result = spawnSync(process.execPath, ['bin/release-live.mjs', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /no live action/);
  }
});

// Actual emitted artifacts remain explicitly labeled fixtures in this offline test.
test('release assembly reuses the packager and keeps evidence outside the public ZIP', t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-assembly-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ui = join(dir, 'ui.html'), icon = join(dir, 'icon.png');
  writeFileSync(ui, '<html>Offline fixture</html>');
  writeFileSync(icon, PNG.sync.write(new PNG({ width: 1, height: 1 })));
  const config = { publisher: 'APort', fixture: true, endpoint: 'https://aport.io/api/task-delivery/mcp', resource: { uri: 'ui://task-delivery/app', domain: 'https://aport.io' }, assets: { ui, icon, screenshots: [icon] } };
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { deployment } = candidate();
  const out = join(dir, 'release');
  const built = assembleRelease({ config, sourceCommit, coreVersion: CORE_VERSION, out, internal: true, deployment });
  assert.equal(built.evaluation.status, 'needs-human');
  assert.deepEqual(built.manifest.release.deployment, deployment);
  assert.equal(built.manifest.release.states.submissionReady, false);
  for (const file of ['START-HERE.md', 'manifest.json', 'evidence.json', 'qualification.json', 'listing.md', 'release-notes.md', 'review-cases.json', 'RUNTIME.md', 'runtime.json', built.manifest.coreArtifact]) assert.ok(readFileSync(join(out, file)).length);
  assert.match(readFileSync(join(out, 'START-HERE.md'), 'utf8'), /Offline checks are not live qualification/);
  const startHere = readFileSync(join(out, 'START-HERE.md'), 'utf8');
  const notes = readFileSync(join(out, 'release-notes.md'), 'utf8');
  assert.doesNotMatch(startHere, /Status:|needs-human|submission-ready/);
  for (const blocker of built.evaluation.blockers) assert.ok(!startHere.includes(blocker.next));
  assert.match(startHere, /Run npm run release:validate/);
  assert.match(startHere, /latest evidence.json/);
  assert.match(startHere, /does not refresh the saved qualification.json/);
  assert.match(startHere, /Follow only the current blockers/);
  assert.doesNotMatch(notes, /Unqualified|live gates remain pending/);
  assert.match(notes, /release:validate/);
  // Synthetic evaluator inputs exercise changing qualification without relabeling
  // the emitted fixture manifest or claiming any live observation.
  const qualificationInput = { manifest: { ...built.manifest, classification: 'public-candidate-unqualified', sourceVerified: true, uncommittedPayload: [] }, deployment };
  const readyEvidence = observed(qualificationInput);
  for (const [evidence, expected] of [[{ version: 1, checks: {} }, 'needs-human'], [readyEvidence, 'submission-ready']]) {
    writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence));
    const current = evaluateRelease({ ...qualificationInput, evidence: readReleaseJson(join(out, 'evidence.json')) });
    assert.equal(current.status, expected);
    assert.equal(readFileSync(join(out, 'START-HERE.md'), 'utf8'), startHere);
    assert.equal(hash(startHere), built.manifest.handoffHashes['START-HERE.md']);
    assert.equal(readFileSync(join(out, 'release-notes.md'), 'utf8'), notes);
  }
  writeFileSync(join(out, 'evidence.json'), JSON.stringify({ version: 1, checks: {} }));
  assert.match(readReleaseJson(join(out, 'manifest.json')).classification, /internal-development-fixture/);
  assert.equal(readReleaseJson(join(out, 'qualification.json')).status, 'needs-human', 'saved results are a snapshot, not the current evaluation');
  assert.deepEqual(Object.keys(built.manifest.handoffHashes).sort(), ['RUNTIME.md', 'START-HERE.md', 'listing.md', 'release-notes.md', 'review-cases.json']);
  for (const [file, expected] of Object.entries(built.manifest.handoffHashes)) assert.equal(hash(readFileSync(join(out, file))), expected);
  for (const [file, expected] of Object.entries(built.manifest.assetHashes)) assert.equal(hash(readFileSync(join(out, 'plugin', file))), expected);
  assert.deepEqual(readReleaseJson(join(out, 'manifest.json')), built.manifest);
  const committedControls = packagingControlInventory(process.cwd(), sourceCommit);
  assert.deepEqual(built.manifest.packagingControlHashes, committedControls);
  assert.ok(committedControls['.gitignore'], 'actual build records controls omitted from npm payload');
  assert.equal(built.manifest.payloadHashes['.gitignore'], undefined);
  const changed = assembleRelease({ config: { ...config, resource: { ...config.resource, uri: 'ui://task-delivery/next' } }, sourceCommit, coreVersion: CORE_VERSION, out: join(dir, 'changed-resource'), internal: true, deployment });
  assert.equal(changed.manifest.coreSha256, built.manifest.coreSha256);
  assert.equal(changed.manifest.hashes.plugin, built.manifest.hashes.plugin);
  assert.equal(changed.manifest.hashes.operations, built.manifest.hashes.operations);
  assert.notEqual(changed.manifest.hashes.runtime, built.manifest.hashes.runtime);
  assert.notEqual(changed.evaluation.identity.deployment, built.evaluation.identity.deployment);
  const stale = evaluateRelease({ manifest: changed.manifest, deployment, evidence: observed({ manifest: built.manifest, deployment }) });
  for (const id of Object.keys(RELEASE_CHECKS).filter(id => id !== 'integration')) assert.equal(stale.checks[id].status, 'stale', id);
  assert.equal(stale.states.submissionReady, false);
  const contents = execFileSync('unzip', ['-Z1', join(out, 'aport-task-delivery.zip')], { encoding: 'utf8' });
  assert.match(contents, /skills\/task-delivery\/SKILL.md/);
  assert.doesNotMatch(contents, /evidence|qualification|reviewer|credential/);
  const consumer = join(dir, 'consumer'); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(out, built.manifest.coreArtifact)], { cwd: consumer, stdio: 'pipe' });
  // Import only the installed tarball, including its final release validator bytes.
  const installed = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {evaluateRelease} from '@uchibeke/gallivant/lib/release_package.mjs'; console.log(JSON.stringify(evaluateRelease(${JSON.stringify({ manifest: built.manifest, deployment })})));`],
    { cwd: consumer, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.deepEqual(JSON.parse(installed).identity, built.evaluation.identity);
  assert.equal(JSON.parse(installed).status, 'needs-human');

  writeFileSync(join(out, 'START-HERE.md'), 'truncated');
  for (const args of [['bin/release-package.mjs', '--mode', 'validate'], ['bin/release-live.mjs', '--host'], ['bin/release-live.mjs', '--backend', 'openai-agents']]) {
    const result = spawnSync(process.execPath, [...args, '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Candidate bytes changed: START-HERE.md/);
  }
  const installedVerification = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {verifyReleasePayload} from '@uchibeke/gallivant/lib/release_package.mjs'; verifyReleasePayload(${JSON.stringify(out)}, ${JSON.stringify(built.manifest)});`],
    { cwd: consumer, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.equal(installedVerification.status, 1);
  assert.match(installedVerification.stderr, /Candidate bytes changed: START-HERE.md/);

  assert.throws(() => assembleRelease({ config, sourceCommit, coreVersion: CORE_VERSION, out, internal: true, deployment }), /empty bounded/);
  assert.ok(readFileSync(join(out, 'manifest.json')).length, 'occupied output must survive');
});
