#!/usr/bin/env node
// Explicit opt-in entry point. Task execution stays in the existing G8 scripts.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readReleaseJson, verifyReleasePayload, evaluateRelease } from '../lib/release_package.mjs';
try {
  const { values } = parseArgs({ options: { out: { type: 'string' }, backend: { type: 'string' }, phase: { type: 'string', default: 'preflight' }, execute: { type: 'boolean' }, host: { type: 'boolean' } } });
  if (!values.out) throw new Error('Supply --out for the exact installed candidate; no live action was taken');
  const manifest = readReleaseJson(join(values.out, 'manifest.json'));
  verifyReleasePayload(values.out, manifest);
  const saved = readReleaseJson(join(values.out, 'qualification.json'));
  const evidence = readReleaseJson(join(values.out, 'evidence.json'));
  const result = evaluateRelease({ manifest, deployment: saved.deployment, evidence });
  if (values.host) {
    if (values.execute || values.backend) throw new Error('Host verification reads actual operator-captured observations; it does not simulate or dispatch a host session');
    const ids = ['integration', 'deployment', 'host', 'recovery', 'reviewer', 'media'];
    console.log(JSON.stringify({ kind: 'record-validation', actualHostExecution: false, checks: Object.fromEntries(ids.map(id => [id, result.checks[id]])), blockers: result.blockers.filter(item => ids.includes(item.id)) }, null, 2));
    process.exitCode = ids.every(id => result.checks[id].status === 'passed') ? 0 : 1;
  } else {
    if (!['openai-agents', 'codex-cloud'].includes(values.backend) || !['preflight', 'implementation', 'correction'].includes(values.phase)) throw new Error('Select --backend openai-agents|codex-cloud and --phase preflight|implementation|correction');
    if (values.execute && (!['implementation', 'correction'].includes(values.phase) || result.checks.integration.status !== 'passed' || result.checks.deployment.status !== 'passed')) throw new Error('Before paid phases, record qualified integration and human-approved deployment for this candidate; use preflight without --execute');
    const script = fileURLToPath(new URL(`../test/${values.backend}-live.mjs`, import.meta.url));
    const child = spawnSync(process.execPath, [script, `--phase=${values.phase}`, ...(values.execute ? ['--execute'] : [])], { stdio: 'inherit', env: process.env });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
