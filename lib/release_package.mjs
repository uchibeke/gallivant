// Release records qualify the existing package; they never dispatch task work.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPluginPackage, validatePublicRelease, runtimeFile, payloadChange } from './plugin_package.mjs';
import { redact } from './execution_io.mjs';
import { canonical } from './learning_data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => digest(canonical(JSON.parse(JSON.stringify(value))));
const fail = message => { throw new Error(message); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000 && redact(value) === value && !/[\x00-\x1f]/.test(value);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const HANDOFF_FILES = ['listing.md', 'release-notes.md', 'review-cases.json', 'START-HERE.md', 'RUNTIME.md'];

// Each observation is a concrete evidence pointer, not a boolean attestation.
// The operator must retain the corresponding observed records for review.
export const RELEASE_CHECKS = Object.freeze({
  integration: { scopes: ['core'], cases: ['mergedFoundation', 'reconciledJob', 'mergedExports', 'pinnedArtifact', 'remainingCriteria', 'humanMerge'], next: 'Reconcile PR #414 and the existing job; pin merged M5 bytes, then reuse or create exactly one workflow integration successor against staging. Require human merge.' },
  deployment: { scopes: ['core', 'tools', 'deployment'], cases: ['humanApproval', 'revision', 'httpsMcp', 'oauthDiscovery', 'durableState', 'singleCoordinator', 'workerCredentials', 'health', 'readiness', 'quotas', 'artifactAuthorization', 'restartNoDuplicate'], next: 'Deploy the pinned runtime through the APort recipe to the authorized target; record revision, scoped discovery, durable restart and coordinator checks.' },
  agents: { scopes: ['core', 'tools', 'deployment'], cases: ['implementation', 'forcedCorrection', 'verifiedFiles', 'tests', 'onePr', 'restart', 'sessionContinuity', 'usage'], next: 'Reconcile the shared USD 10 ledger, configure OPENAI_AGENTS_LIVE_HOME/PRD/REPO/CAMPAIGN_LEDGER, then run existing G8 implementation and correction phases sequentially.' },
  cloud: { scopes: ['core', 'tools', 'deployment'], cases: ['implementation', 'forcedCorrection', 'verifiedFiles', 'tests', 'onePr', 'restart', 'nativeOrSuccessorContinuity', 'usage'], next: 'Implement and qualify the supported environment-to-repository check at the Cloud adapter; configure CODEX_CLOUD_LIVE_HOME/PRD/REPO/CAMPAIGN_LEDGER before existing G8 phases.' },
  host: { scopes: ['core', 'tools', 'plugin', 'deployment'], cases: ['installedCandidate', 'freshAccount', 'questions', 'requirements', 'readiness', 'availableRemoteHarness', 'implementation', 'progress', 'files', 'onePr', 'correction', 'sidebar', 'panel', 'reopenSameTask'], next: 'After qualified deployment, install this exact ZIP in actual ChatGPT; exercise and capture the fresh-account task and supported sidebar/panel reconnect.' },
  recovery: { scopes: ['core', 'tools', 'plugin', 'deployment'], cases: ['accountIsolation', 'expiredAuthentication', 'staleRevision', 'duplicateStart', 'providerOutage', 'unsupportedCancellation'], next: 'Exercise each negative scenario against the actual service/UI using isolated accounts; retain observed recovery and non-overlap records.' },
  reviewer: { scopes: ['core', 'tools', 'plugin', 'deployment'], cases: ['cleanSession', 'dedicatedTenant', 'sampleRepository', 'usableAccount', 'allowance', 'noVpnMfaSmsMagicLink', 'securePortalStorage'], next: 'Provision and test dedicated reviewer access in a clean session; keep credentials and private instructions only in secure operator storage/portal.' },
  publisher: { scopes: ['plugin', 'deployment'], cases: ['businessIdentity', 'organizationPermissions', 'eligibleProjectResidency', 'domainChallengePreservesOthers', 'customerResidencyUnchanged', 'legalProductSupportUrls'], next: 'Record APort business/org/project eligibility, working URLs and the assigned domain challenge without overwriting existing tokens.' },
  scans: { scopes: ['core', 'tools', 'plugin', 'deployment'], cases: ['package', 'mcp', 'skills'], next: 'Upload the candidate to the authorized portal draft and record package/skill scans; use MCPs > connected server > Rescan for the exact deployment. Do not submit.' },
  media: { scopes: ['plugin', 'deployment'], cases: ['authenticScreenshots', 'accessibleDemoRecording'], next: 'Capture the actual installed host and publish the authorized demo recording at the configured URL; verify reviewer access.' },
  upgrade: { scopes: ['core', 'tools', 'deployment'], cases: ['backup', 'compatibleUpgrade', 'rollback', 'queuedIdentities', 'activeIdentities', 'savedState', 'unsupportedMigrationRefused'], next: 'Rehearse the existing state check/backup/migrate/restore commands with matching runtime manifests, preserved identities and a safe incompatible-version refusal.' },
});

export function readReleaseJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) fail('Release JSON must be a regular non-symlink file of at most 1 MiB');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function fileBytes(dir, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) fail('Unsafe release payload path');
  let current = resolve(dir);
  for (const part of path.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) fail('Release payload cannot contain symlinks');
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) fail('Release payload must be a bounded regular file');
  return readFileSync(current);
}
export function releaseIdentity(manifest, deployment) {
  if (!sha(manifest.coreSha256) || !sha(manifest.hashes?.plugin) || !sha(manifest.hashes?.operations) || !sha(manifest.hashes?.runtime) || !sha(manifest.dependencyLockSha256)) fail('Incomplete package manifest hashes');
  if (!exact(deployment, ['revision', 'configurationSha256', 'endpoint']) || !text(deployment.revision) || !sha(deployment.configurationSha256) || deployment.endpoint !== manifest.endpoint) fail('Record the actual deployment revision, non-secret configuration digest and matching endpoint');
  return {
    core: hash({ artifact: manifest.coreSha256, lock: manifest.dependencyLockSha256, payload: manifest.payloadHashes }),
    tools: hash({ operations: manifest.hashes.operations, schema: manifest.schemaHashes, submissionSchema: manifest.submissionSchemaSha256 }),
    plugin: manifest.hashes.plugin,
    deployment: hash(deployment),
  };
}
export function evaluateRelease({ manifest, deployment, evidence = { version: 1, checks: {} } }) {
  if (!exact(evidence, ['version', 'checks', 'states']) || evidence.version !== 1 || !exact(evidence.checks, Object.keys(RELEASE_CHECKS))) fail('Unsupported release evidence schema; preserve the prior record and migrate explicitly');
  const identity = releaseIdentity(manifest, deployment);
  const checks = {}, blockers = [];
  const publicCandidate = manifest.classification === 'public-candidate-unqualified' && manifest.sourceVerified === true && Array.isArray(manifest.uncommittedPayload) && manifest.uncommittedPayload.length === 0;
  if (!publicCandidate) blockers.push({ id: 'candidate', next: 'Build the public candidate from clean merged source with authentic assets; fixtures cannot qualify.' });
  for (const [id, rule] of Object.entries(RELEASE_CHECKS)) {
    const record = evidence.checks[id];
    if (record && (!exact(record, ['kind', 'status', 'at', 'bindings', 'observations']) || !exact(record.bindings, rule.scopes) || !exact(record.observations, rule.cases))) fail(`Unsupported ${id} evidence fields; keep secrets and private instructions outside release records`);
    if (record && (!['live', 'offline', 'fixture'].includes(record.kind) || !['passed', 'failed', 'blocked', 'unverified'].includes(record.status) || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) || Object.values(record.bindings).some(value => !sha(value)) || Object.values(record.observations).some(value => !text(value)))) fail(`Invalid ${id} observation; use bounded non-secret pointers and SHA-256 bindings`);
    const bound = record && rule.scopes.every(scope => record.bindings?.[scope] === identity[scope]);
    const currentLive = record?.kind === 'live' && Date.parse(record.at) <= Date.now();
    const complete = currentLive && record.status === 'passed' && rule.cases.every(name => text(record.observations?.[name]));
    const status = !record ? 'missing' : !bound ? 'stale' : currentLive && ['failed', 'blocked'].includes(record.status) ? record.status : complete && publicCandidate ? 'passed' : 'unverified';
    checks[id] = { status, required: rule.cases, scopes: rule.scopes };
    if (status !== 'passed') blockers.push({ id, status, next: rule.next });
  }
  // Later owner actions are independently recorded, never inferred from readiness.
  const stateNames = ['codeMerged', 'submitted', 'approved', 'published'];
  if (evidence.states && !exact(evidence.states, stateNames)) fail('Unsupported publication state');
  const states = {};
  for (const name of stateNames) {
    const record = evidence.states?.[name];
    if (record && (!exact(record, ['at', 'pointer', 'identity']) || !text(record.pointer) || !Number.isFinite(Date.parse(record.at)) || Date.parse(record.at) > Date.now() || !exact(record.identity, Object.keys(identity)) || Object.values(record.identity).some(value => !sha(value)))) fail('Invalid owner state evidence');
    states[name] = !!record && Object.keys(identity).every(key => record.identity[key] === identity[key]);
  }
  const liveQualified = ['integration', 'deployment', 'agents', 'cloud', 'host', 'recovery', 'upgrade'].every(id => checks[id].status === 'passed');
  const submissionReady = !blockers.length && states.codeMerged;
  if (!states.codeMerged) blockers.push({ id: 'codeMerged', next: 'Record the human merge of this exact candidate source; a review PR is not merge evidence.' });
  return { version: 1, status: submissionReady ? 'submission-ready' : 'needs-human', identity, checks, blockers, rerun: blockers.filter(b => RELEASE_CHECKS[b.id]).map(b => b.id), states: { ...states, liveQualified, submissionReady } };
}

export function verifyReleasePayload(dir, manifest, { sourceRoot = root } = {}) {
  const files = { [manifest.coreArtifact]: manifest.coreSha256, 'aport-task-delivery.zip': manifest.hashes?.plugin, 'runtime.json': manifest.hashes?.runtime, 'operations.json': manifest.hashes?.operations };
  if (!exact(manifest.handoffHashes, HANDOFF_FILES)) fail('Incomplete handoff hashes; rebuild the release candidate');
  for (const path of HANDOFF_FILES) files[path] = manifest.handoffHashes[path];
  if (!manifest.assetHashes || typeof manifest.assetHashes !== 'object' || Array.isArray(manifest.assetHashes) || !Object.keys(manifest.assetHashes).length) fail('Incomplete plugin asset hashes; rebuild the release candidate');
  for (const [path, expected] of Object.entries(manifest.assetHashes)) files[`plugin/${path}`] = expected;
  for (const [path, expected] of Object.entries(files)) if (!sha(expected) || digest(fileBytes(dir, path)) !== expected) fail(`Candidate bytes changed: ${path}; rebuild and repeat affected checks`);
  // Compare the source payload, including new/deleted packaging inputs, at validation time.
  for (const [path, expected] of Object.entries(manifest.payloadHashes || {})) {
    if (digest(fileBytes(sourceRoot, path)) !== expected) fail(`Source payload changed: ${path}; rebuild before qualification`);
  }
  const tracked = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 16777216 }).split('\0').filter(path => runtimeFile(path) && !path.startsWith('node_modules/')).sort();
  const packed = Object.keys(manifest.payloadHashes || {}).filter(path => !path.startsWith('node_modules/')).sort();
  if (JSON.stringify(tracked) !== JSON.stringify(packed)) fail('Source payload paths changed; rebuild before qualification');
  const changes = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignored=matching'], { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 1048576 }).split('\0').filter(Boolean).map(line => line.slice(3));
  if (changes.some(path => payloadChange(path) || /^\.(?:npmignore|gitignore|npmrc)$/.test(path))) fail('Uncommitted source/packaging inputs; rebuild the candidate after committing them');
  return true;
}

export function releasePreflight(config, setup = {}) {
  const packageCheck = validatePublicRelease(config);
  const requirements = {
    target: 'Confirm the authorized APort deployment target and permanent domain.',
    providerAccess: 'Verify the selected model/environment/repository through provider setup, not CLI sign-in alone.',
    repositoryAccess: 'Verify disposable repository and branch authority for the campaign.',
    reviewerAccess: 'Test a dedicated reviewer account/tenant in a clean session; store private setup in the portal.',
    executionAllowance: 'Reconcile the existing shared USD 10 campaign ledger, including unknown prior spend, before reserving another phase.',
  };
  if (!exact(setup, Object.keys(requirements))) fail('Setup accepts only concrete prerequisite evidence pointers');
  const blockers = packageCheck.errors.map(next => ({ id: 'publisher-package', next }));
  for (const [id, next] of Object.entries(requirements)) if (!text(setup[id])) blockers.push({ id, next });
  return { version: 1, status: blockers.length ? 'needs-human' : 'prepared-unqualified', submissionReady: false, blockers };
}

export function assembleRelease({ config, out, coreVersion, sourceCommit, deployment, evidence, internal = false }) {
  // The existing builder refuses occupied outputs and owns archive creation.
  const manifest = buildPluginPackage({ config, out, coreVersion, sourceCommit, internal });
  try {
    const evaluation = evaluateRelease({ manifest, deployment, evidence });
    manifest.release = { deployment, identity: evaluation.identity, observedAt: new Date().toISOString(), states: evaluation.states };
    writeFileSync(join(out, 'evidence.json'), json(evidence || { version: 1, checks: {} }));
    writeFileSync(join(out, 'qualification.json'), json({ deployment, ...evaluation }));
    writeFileSync(join(out, 'listing.md'), `${config.listing?.longDescription || 'Scoped task delivery through APort.'}\n`);
    writeFileSync(join(out, 'release-notes.md'), `${config.publication?.release_notes || 'Release candidate assembled. Run release:validate for current qualification results.'}\n`);
    writeFileSync(join(out, 'review-cases.json'), json(config.review || {}));
    writeFileSync(join(out, 'START-HERE.md'), `# Release candidate\n\nThis file contains stable setup instructions. Offline checks are not live qualification.\n\nInstall ${manifest.coreArtifact} with npm install --ignore-scripts. Import the combined aport-task-delivery.zip in the supported host after qualifying the deployment. RUNTIME.md contains the existing runtime, state migration, backup and rollback commands. manifest.json binds package, schema, lock and payload bytes. Its release states and the saved qualification.json results are assembly-time snapshots; qualification.json also supplies the recorded deployment.\n\nRun npm run release:validate -- --out "$RELEASE_DIR" from the exact source checkout. Read the returned JSON status, checks, blockers, rerun and states for current qualification. Validation reads the latest evidence.json and checks it against this candidate and the recorded deployment; it does not refresh the saved qualification.json. Follow only the current blockers and their next steps. Rerun validation after updating evidence and before handoff. Use docs/release-qualification.md for the opt-in provider and host procedures.\n\nPrivate reviewer instructions and credentials belong only in secure operator storage/portal. Metadata or skill changes require a new ZIP; live MCP updates require a server rescan. Submit, approve and publish are separate owner actions, never inferred here.\n`);
    // The manifest is the trust anchor; only evidence/qualification records are mutable.
    // Plugin staging files already have hashes from the shared package builder.
    manifest.handoffHashes = Object.fromEntries(HANDOFF_FILES.map(path => [path, digest(fileBytes(out, path))]));
    writeFileSync(join(out, 'manifest.json'), json(manifest));
    return { manifest, evaluation };
  } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
}
