#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readReleaseJson, releasePreflight, assembleRelease, verifyReleasePayload, evaluateRelease } from '../lib/release_package.mjs';
try {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'preflight' }, config: { type: 'string' }, setup: { type: 'string' }, evidence: { type: 'string' }, deployment: { type: 'string' }, out: { type: 'string' }, 'source-commit': { type: 'string' }, 'core-version': { type: 'string' }, internal: { type: 'boolean' } } });
  let report;
  if (values.mode === 'preflight') {
    if (!values.config) throw new Error('Pass --config with the existing package configuration; keep private credentials outside it');
    report = releasePreflight(readReleaseJson(values.config), values.setup ? readReleaseJson(values.setup) : {});
  } else if (values.mode === 'build') {
    if (!values.config || !values.out || !values.deployment) throw new Error('Build requires --config, --out and --deployment with the observed target revision and configuration digest');
    report = assembleRelease({ config: readReleaseJson(values.config), out: values.out, deployment: readReleaseJson(values.deployment), evidence: values.evidence ? readReleaseJson(values.evidence) : undefined, coreVersion: values['core-version'], sourceCommit: values['source-commit'], internal: values.internal }).evaluation;
  } else if (values.mode === 'validate') {
    if (!values.out) throw new Error('Validate requires --out with the existing candidate directory');
    const manifest = readReleaseJson(join(values.out, 'manifest.json'));
    verifyReleasePayload(values.out, manifest);
    const saved = readReleaseJson(join(values.out, 'qualification.json'));
    report = evaluateRelease({ manifest, deployment: values.deployment ? readReleaseJson(values.deployment) : saved.deployment, evidence: readReleaseJson(values.evidence || join(values.out, 'evidence.json')) });
  } else throw new Error('Use preflight, build or validate; this command never deploys, dispatches or publishes');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'submission-ready' && report.status !== 'prepared-unqualified') process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
