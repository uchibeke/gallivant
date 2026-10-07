---
status: ready
harness: codex
sources:
  - docs/plans/plugin-ready-gallivant.md
  - docs/plans/plugin-hosting-and-live-tests.md
  - docs/plans/aport-task-delivery-integration.md
  - docs/prds/natural-language-tasks.md
  - docs/prds/hosted-codex-harnesses.md
  - docs/prds/openai-agents-harness.md
  - docs/prds/codex-cloud-harness.md
aport_decision: 2c230bca-46de-4307-bd01-11a8b159fe01
---

# Package Gallivant for APort task delivery and plugin release

## Problem

Gallivant needs to power a ChatGPT plugin through APort without becoming a copied orchestration product. Users should describe work, resolve requirements, choose a configured harness, follow implementation and review a GitHub PR. This milestone delivers reusable task/runtime exports and one reproducible plugin packager. A separate, already-authored APort integration owns the public endpoint, existing auth/storage and shared web/plugin UI. Final deployment and real submission qualification follow in M6; clear ownership lets both repos progress without a dependency cycle.

## User stories

- As a plugin user, I want to describe and run a task through APort, so that I can receive a reviewable PR without installing Gallivant locally.
- As a user, I want to choose Agents API or Codex Cloud with clear setup requirements, so that the selected harness matches my authorized account.
- As an APort maintainer, I want versioned task contracts and portable adapters, so that the endpoint and shared UI reuse Gallivant's behavior.
- As a release owner, I want one reproducible plugin packager, so that compatible Gallivant improvements reach the plugin without duplicate builds.
- As an existing operator, I want CLI and Command Center compatibility, so that the plugin does not disrupt current work.

## Delivery contract

The carried `docs/plans/aport-task-delivery-integration.md` is the latest ownership/dependency correction and overrides conflicting endpoint, UI and downstream-job instructions in the older carried plans. All other G1–G9 behavior and both remote harness requirements remain. M5 delivers upstream exports without waiting for the APort deployment. M6 consumes the existing `aporthq/agent-passport/aport-task-delivery-mcp` job/PR and performs live qualification. No duplicate endpoint brief, public UI or runner.

## Acceptance criteria

- Given the first four milestones merged, When implementation begins, Then their real task service and both hosted backends are used as dependencies without recreating or silently dropping either backend.
- Given a clean installed package, When an external consumer imports documented task/capability exports, Then it can prepare, answer, validate, start, inspect and control work without source-relative deep imports or import-time daemon/config side effects; the CLI uses the same service.
- Given reusable operation schemas and dispatch adapters, When APort supplies validated scoped identity and requests, Then preparation, readiness, execution, evidence and supported controls preserve revisions, task identity, idempotency and review decisions; there is one operation mapping with truthful read/write annotations and no auth bypass.
- Given the portable core and supported runtime adapters, When durable store, GitHub/provider transport, credentials and wake-up scheduling are injected, Then one fenced coordinator persists dispatch intent and reconciles changes without an open UI/request; restart, eviction, duplicate callbacks and unknown provider state cannot create duplicate paid work.
- Given the existing Pages deployment target, When runtime compatibility is tested, Then actual package imports and bounded coordinator execution are demonstrated on each claimed runtime; unsupported Node/Cloud dispatch dependencies produce an exact minimal deployment remedy instead of a copied loop, invented API or mandatory new Worker.
- Given shared task view models, capability descriptions and UI-resource configuration, When the APort adapter consumes them, Then it can render questions, brief, harness choice, allowance, progress, bounded logs, artifacts, PR links and supported controls without reimplementing lifecycle rules; UI reads create no provider pollers.
- Given two users or hostile inputs, When consumer tests attempt cross-account operations, path traversal, secret retrieval or unsupported provider URLs, Then scoped contracts reject unauthorized requests and secrets stay outside UI/model context, logs and exports; production authorization remains owned by APort.
- Given existing local state and Command Center integration, When the package is upgraded, Then routes, status/run output, source snapshots and controls remain compatible or have an explicit migration; optional hosted dependencies do not break ordinary CLI use or require another daemon.
- Given an explicit core version and APort endpoint/resource configuration, When the package command runs, Then it produces one combined skills/MCP plugin and reusable runtime artifact/recipe, records source/version/contracts/hashes, preserves licensing and excludes secrets and unrelated files.
- Given missing publisher/support metadata, an example endpoint or unavailable built UI assets, When public-release validation runs, Then it refuses a submission-ready artifact with actionable errors while clearly labeling any internal development fixture package.
- Given a compatible update, When package/runtime upgrade and rollback tests run, Then supported task/provider/brief identities survive and shared contracts remain compatible; incompatible major versions fail with a migration remedy and cannot silently replace active-job code.
- Given a clean consumer directory, When `test:plugin-package` builds and installs actual artifacts, Then import, schema, reusable MCP-dispatch and deterministic full task-flow tests pass using local/API/Cloud test transports and emitted resource fixtures; source-only imports cannot make the test pass and fixtures are never called installed-host evidence.
- Given the APort dependency, When the handoff is produced, Then it names the actual merged package exports/digest, scopes, operation/schema versions, runtime/store interfaces, asset inputs and build/migrate/rollback commands for the existing APort job; no competing integration PRD or final UI implementation is generated.
- Given M5 completion, When its bounded audit index is handed to M6, Then every criterion links real implementation/tests and the remaining APort deployment, live provider and actual host checks remain mandatory M6 gates; publisher is APort and no release approval is claimed.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:plugin-package`
- `git diff --check`

Implement artifact-installed consumer/runtime tests. Normal tests use disposable directories and deterministic transports. M6 performs installed-host/live verification against the actual APort UI and deployment; fixture screenshots cannot replace it.

## Where to look

- `docs/plans/aport-task-delivery-integration.md`, then `docs/plans/plugin-ready-gallivant.md` G1, G3a and G7–G9 and `docs/plans/plugin-hosting-and-live-tests.md` for unchanged runtime/release requirements and shared API allowance.
- Carried predecessor PRDs and their merged task/execution services; `package.json`, `bin/gallivant.mjs`, `lib/context.mjs`, `lib/control.mjs`, `lib/commands/serve.mjs`, `lib/tracker/` and `templates/tracker/`.
- `test/tracker.test.mjs`, `test/tracker_controls.test.mjs`, `test/security.test.mjs`, `test/status.test.mjs`, `test/public_format.test.mjs` and predecessor backend tests.
- Official MCP, Extensions, auth, packaging and submission references in the carried plans; reverify current schemas and use supported SDKs.

## Out of scope

- APort route/auth/region implementation or a competing public React app: those belong to its existing task-delivery PRD; do not modify another repo from this implementation.
- A standalone runner, copied review/state logic, broad billing UI, required custom file viewer, renaming the CLI or automatic active-job upgrades.
- Live release qualification, directory submission, automatic merging, unapproved purchases or claiming plugin installation includes GitHub access or paid inference allowance.
