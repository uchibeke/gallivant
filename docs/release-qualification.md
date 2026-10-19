# Release qualification

The release command extends the existing package builder and its runtime recipe.
It does not run a second coordinator, deploy, submit, or purchase anything. A
regular review PR is not release completion. Missing live evidence remains
`needs-human`; offline success cannot satisfy the live criteria.

Run these commands from the exact source checkout after `npm ci --ignore-scripts`.
Use a single empty output directory outside that checkout, conventionally
`$RELEASE_DIR` ending in `release/aport-context`. Keep operator configuration,
credentials, the shared campaign ledger and private reviewer instructions outside
Git and outside that directory. The public package configuration is the existing
[package configuration](task-delivery.md), including real UI/assets, OAuth,
APort metadata, exactly five positive and three negative review scenarios, and
the accessible actual demo recording URL. Do not substitute generated images.

```sh
npm run release:preflight -- --config "$PACKAGE_CONFIG" --setup "$SETUP_EVIDENCE"
npm run release:package -- --config "$PACKAGE_CONFIG" --out "$RELEASE_DIR" --core-version 0.2.0 --source-commit "$SOURCE_COMMIT" --deployment "$DEPLOYMENT_RECORD" --evidence "$LIVE_EVIDENCE"
npm run release:validate -- --out "$RELEASE_DIR"
```

Preflight accepts only `target`, `providerAccess`, `repositoryAccess`,
`reviewerAccess` and `executionAllowance` evidence pointers in the setup JSON.
These pointers document operator checks; presence is not model-access proof.
Known target/domain and the existing shared USD 10 authority must not be reported
as unknown. Missing reservation/account/model/reviewer configuration is a concrete
remaining prerequisite. Resolve each returned next step before dependent actions.
Preflight success is `prepared-unqualified`, never submission readiness.

Deployment JSON has exactly `revision`, `configurationSha256` and `endpoint`.
Use the observed revision, SHA-256 of the canonical non-secret deployment
configuration, and `https://aport.io/api/task-delivery/mcp`. A dummy revision does
not establish deployment. Reuse APort's Pages endpoint, OAuth and shared `/web`
UI, with the existing authenticated binding to the supported durable Node runtime.
The deployment operator must record single-owner, restart, health, quota and
credential observations. Do not provision new hosting to fill missing evidence.

The builder emits the original combined ZIP, npm runtime tarball, runtime recipe,
operation schemas and hash manifest, plus START-HERE, listing, release notes,
review cases, evidence and qualification records. Screenshots remain in the
plugin assets and the demo URL in its review metadata. Records never enter the
public ZIP. The builder refuses occupied output and cleans up its own failed
assembly. `--internal` is only for deterministic fixture artifacts, which can
never qualify even if supplied with passing records.

## Evidence and invalidation

`evidence.json` has version `1`, `checks`, and optional `states`. The authoritative
case list, dependencies and remedies are exported as `RELEASE_CHECKS` from
`lib/release_package.mjs`. Each check records `kind` (`live`, `offline`, `fixture`),
`status` (`passed`, `failed`, `blocked`, `unverified`), `at` (observed timestamp),
`bindings` and `observations`. Bindings copy only that check's required core,
tools, plugin and deployment digests from `qualification.json.identity`.
Observations map every required case to a concrete run record, test output,
artifact or capture pointer. Keep those underlying records accessible to the
reviewer. This validator checks consistency and completeness of recorded evidence;
it cannot authenticate a narrated observation or replace actually performing it.
Never manufacture a record to make a gate pass.
Current, correctly bound live `failed` and `blocked` outcomes retain those statuses
in checks and blockers, even if the attempt stopped before collecting every case.
Outdated bindings remain `stale`; fixture, offline and future observations remain
`unverified`.

Core hashes cover the packed bytes and lock; tool hashes cover operations and
schemas; plugin hashes cover exact ZIP bytes; deployment hashes cover revision,
configuration, endpoint and the runtime's resource settings, requirements, exports
and contract versions. Resource URI/domain/CSP changes therefore invalidate every
deployment-dependent check even when the archive, ZIP and deployment record are
unchanged. Runtime serialization and source-provenance-only changes do not alter
this canonical configuration identity. Payload validation also checks that these
settings match the hashed `runtime.json`. Records using the earlier deployment digest
must be requalified; the independent integration check remains reusable.
An affected binding becomes `stale` and appears in
`rerun`; independent checks remain reusable. Validation also rehashes archives,
source payload files and the current tracked payload inventory. New, removed,
modified or uncommitted executable/packaging inputs require a rebuild. Audit-only
record changes outside the package payload do not invalidate unchanged artifacts.
The manifest also records `handoffHashes` for listing, release notes, review cases,
START-HERE and RUNTIME. Validation rehashes those files and the staged plugin files
using the builder's `assetHashes`. Older manifests without complete handoff hashes
require rebuilding. Treat the manifest as the immutable trust anchor; only
`evidence.json` and `qualification.json` are intentionally mutable release records.
START-HERE and the default release notes contain stable instructions, not a saved
readiness verdict or blocker list. Run `release:validate` after evidence updates
and before handoff; its returned `status`, `checks`, `blockers`, `rerun` and `states`
reflect current evidence. Validation does not rewrite `qualification.json`.
The saved qualification results and `manifest.release.states` describe assembly
time; the validator reads the saved deployment but recomputes qualification.

`codeMerged`, `submitted`, `approved` and `published` each require their own
`{at, pointer, identity}` record. `liveQualified` and `submissionReady` are derived
separately. Neither qualification nor a passing scan implies submission, approval
or publication. Missing publisher or domain prerequisites block readiness.

## Live and host verification

The existing G8 scripts own task dispatch and correction. Use their documented
private configurations and the **same** campaign ledger, reconcile previous
reservations and unknown usage first, and preserve task/session/PR identities.
The current Cloud adapter refuses new dispatch until its supported
repository-to-environment check can be demonstrated. Do not work around that gate.
For this harness installation, configure the worker binary as the exact path
`/Users/uchi/.local/share/gallivant/codex/node_modules/.bin/codex`; do not assume PATH
selects it. Neither help nor login status qualifies inference.

```sh
npm run test:release:live -- --out "$RELEASE_DIR" --backend openai-agents --phase preflight
npm run test:release:live -- --out "$RELEASE_DIR" --backend openai-agents --phase implementation --execute
npm run test:release:live -- --out "$RELEASE_DIR" --backend openai-agents --phase correction --execute
npm run test:release:live -- --out "$RELEASE_DIR" --backend codex-cloud --phase preflight
npm run test:release:live -- --out "$RELEASE_DIR" --backend codex-cloud --phase implementation --execute
npm run test:release:live -- --out "$RELEASE_DIR" --backend codex-cloud --phase correction --execute
npm run test:release:host -- --out "$RELEASE_DIR"
```

Paid phases require bound integration and human-approved deployment evidence.
Run sequentially, once per required phase. Preserve failed/unknown intent and
reconcile it instead of redispatching. Record provider usage or explicit unknowns;
unknown spend cannot be silently deducted as zero. These commands run from the
source checkout; G8 test drivers are not installed runtime exports.

The host command is explicitly **record validation**, not browser automation or
an installed-host test. Before supplying its evidence, use the actual ChatGPT host
with the exact candidate, a fresh account and the restricted sample repository.
Exercise questions, requirements, real readiness, available remote harness,
implementation, progress, files, PR, correction and same-task reconnect through
the supported sidebar/panel surfaces. Capture authentic screenshots and video.
Test cross-account access, expired auth, stale revisions, duplicate start, provider
outage and unsupported cancellation in that isolated live environment. Reopen the
conversation and verify saved task identity rather than rebuilding chat history.
A preview connection or old deployment observation cannot certify this candidate.

## Integration dependency

First inspect the existing `aporthq/agent-passport/aport-task-delivery-mcp` job
and PR #414. The 2026-10-18 registry observation was `done`; do not resume it.
PR #425 also merged to staging and must be reconciled to avoid duplicating its
connected-runtime work. M5 PR #12 merged; rebuild the actual selected artifact
and pin its digest before preparing a continuation. Carry the merged
`_plans/task-delivery-contract.md`, the original unmet criterion mapping, and
all shipped integration work into exactly one successor named
`aport-task-delivery-workflow-integration`, only if still necessary. Check existing
jobs and PRs first. Use the target repository's instructions and configured base
(`staging` at observation time), not this repository's `main`.

From that authorized operator checkout, after reconciling controls and the pin:

```sh
gallivant status --json
gallivant ready docs/prds/aport-task-delivery-workflow-integration.md
gallivant start docs/prds/aport-task-delivery-workflow-integration.md --base staging --no-open
```

If the successor already exists, inspect and resume that identity using the normal
controls instead of starting another task. Human merge and qualified deployment
remain dependencies before host tests. The connected preview account exposes only
the onboarding qualification repository, so it cannot create this integration
job; repository operator controls and the actual M5 pin must be supplied there.
Do not reset the completed foundation, reopen its merged PR or weaken readiness.

## Upgrade and rollback

Use the installed `task-delivery-state` command and matching emitted manifests:

```sh
task-delivery-state check --home "$DURABLE_HOME" --manifest "$CURRENT_RUNTIME"
task-delivery-state backup --home "$DURABLE_HOME" --manifest "$CURRENT_RUNTIME" --out "$STATE_BACKUP"
task-delivery-state migrate --home "$DURABLE_HOME" --manifest "$NEXT_RUNTIME"
task-delivery-state rollback --backup "$STATE_BACKUP" --out "$RESTORED_HOME" --manifest "$CURRENT_RUNTIME"
```

Coordinate maintenance with the existing owner lock; do not replace active pinned
jobs' artifact. Unsupported versions stop until a compatible migration exists.
Start the restored coordinator with its matching runtime and verify queued/active
identities and saved state without duplicate dispatch. Rebuild with the release
command above after code/configuration changes. Metadata/skills changes need a
new ZIP; eligible live MCP updates use **MCPs → connected server → Rescan** in the
existing portal draft. Preserve approved contracts and the registered MCP URL.

Current rules checked 2026-10-18: [submission](https://developers.openai.com/plugins/deploy/submission),
[extensions](https://developers.openai.com/plugins/build/extensions),
[remote MCP review](https://developers.openai.com/plugins/deploy/app-review).
The documented package metadata belongs under `extensions.com.openai`; reviewer
credentials and private instructions belong in the portal. Business identity,
org permissions, eligible publisher project residency, assigned domain challenge
and package/MCP/skill scans require actual outcomes. Publisher project eligibility
does not change APort customer residency. Never overwrite another plugin's domain
challenge. The owner alone performs remaining submission attestations/actions.
