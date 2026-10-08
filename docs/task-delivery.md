# Task delivery package contract (M5)

APort is publisher and owns OAuth, tenant/region routing, repository authority,
HTTP transport, persistence bindings and the shared web/plugin UI. This package
owns task/readiness/review decisions and provider transports. The existing
`aporthq/agent-passport/aport-task-delivery-mcp` job produced merged
[PR #414](https://github.com/aporthq/agent-passport/pull/414); reuse that integration.
No new integration brief, public UI, database or competing runner is supplied.

## Installed exports

Core `0.2.0`, task schema `1`, execution schema `1`, operation schema `1`.
The candidate digest comes from the emitted `runtime.json`/`manifest.json`;
pin the artifact produced from the eventual human-merged commit, not this branch.

| Import | Public API |
| --- | --- |
| `gallivant/tasks` | `createTaskService`, `TASK_VERSION`; same service used by CLI task commands |
| `gallivant/capabilities` | `executionCapabilities`, `capabilitiesFor`, setup/runtime requirements |
| `gallivant/task-delivery` | `createTaskDelivery` scoped operation dispatcher |
| `gallivant/task-delivery/contracts` | `TASK_OPERATIONS`, versions, compatibility handshake, UI resource configuration |
| `gallivant/task-delivery/views` | `taskView`, `modelSummary`; saved observations only |
| `gallivant/task-delivery/store` | `createDeliveryStore`, `scopeKey`; single-host durable receipt adapter |
| `gallivant/task-delivery/mcp` | `registerTaskDelivery`; lazy optional MCP SDK peer `1.32.1` |
| `gallivant/execution` | Existing `makeExecution`, cached inspect and coordinator reconciliation |
| `gallivant/providers/openai-agents` | Existing managed session transport and setup checks |
| `gallivant/providers/codex-cloud` | Existing native CLI transport and setup checks |
| `gallivant/runtime/coordinator` | `createCoordinator` fenced bounded wake envelope |
| `gallivant/runtime/node` | `createNodeOwnerStore`, `createNodeCoordinator`, requirements |
| `gallivant/runtime/state` | Check, migrate, private backup and fresh-namespace rollback |
| `gallivant/runtime/node/dependencies` | State/config/log/identity constructors, canonical tick/readiness/controls, bounded log reader and atomic storage helpers for injected Node adapters |
| `gallivant/plugin-package` | Single reproducible package builder and public metadata validator |

Imports read no operator configuration, invoke no provider and start no daemon.
Existing `./lib/*` compatibility imports remain; consumers use the named exports.
No new CLI daemon is required. Existing registry/run/source files, tracker routes,
Command Center SSE/history, statuses and controls retain their version-1 shapes.

## Scoped operation adapter

```js
import { createTaskDelivery } from 'gallivant/task-delivery';
import { createDeliveryStore } from 'gallivant/task-delivery/store';
const delivery = createTaskDelivery({
  manifest: emittedRuntimeManifest, // load this installed artifact's runtime.json
  authorize: aportAuthorize, // validate OAuth/audience/region/repository on EVERY call
  contextFor: aportScopedNodeContext,
  store: createDeliveryStore('/durable/preview/delivery'),
  schedule: aportEnqueueWake,
  secretsFor: aportPrivateRedactionValues,
});
const task = await delivery.dispatch('prepare', {
  repositoryId: 'widget', harness: 'openai-agents',
  text: 'Describe the requested work and its constraints.',
  allowance: { budgetUsd: 1, runtimeMs: 60000 },
  operationId: 'request-1', expectedRevision: 0,
}, authenticatedIdentity);
```

`authorize` must return validated `tenant`, `account`, `environment`, `region`,
`scopes` (`task-delivery:read` or `task-delivery:write`) and authorized repository
IDs. Identity comes from APort's authenticated request context, never tool input.
`contextFor(scope, repositoryId)` supplies `{ctx, repository:{dir,repo,context}}`.
Each context and durable home must be isolated by all four scope dimensions;
credential/GitHub/provider resolution must enforce the same scope. Selected
context IDs map to trusted repository paths. No paths, endpoints or credentials
are accepted by the public schemas. Do not supply `taskOptions` in production;
that dependency injection seam is used by deterministic consumer fixtures.

The durable receipt store interface is `read(scope)` and
`transaction(scope, async (data, save) => result)`; `save` must commit before it
resolves. It serializes the scope for the entire mutation and retains task
ownership, exact request fingerprints, intent, acknowledgement and pending wake.
This release's filesystem adapter supports one host on a durable volume. APort
can supply another adapter only with equivalent tested transaction/ownership
semantics. Shared physical storage alone grants no authority.
Delivery mutations also claim the scoped home's daemon ownership lock before
saving intent and hold it through task effects, receipt acknowledgement and wake
scheduling. Backup, migration and coordinator wakes therefore refuse concurrent
ownership; retry the same operation ID after the owner releases. The scheduler
must enqueue a future wake, never execute a coordinator inline. Read operations
do not acquire this owner or create provider pollers.
The dispatcher requires its own emitted `runtime.json` as `manifest`; it captures
that identity at construction and checks the exact installed version/digest under
ownership on every mutation, including receipt replays. Migrate each scoped home
before enabling requests. After migration to another artifact, retire old request
handlers; never substitute the namespace's new pin as an old handler's manifest.
Consumers upgrading from the earlier dispatcher signature must add this manifest
and initialize the scoped pin. Reads do not validate or replace that pin.

All mutations require operationId and expectedRevision; prepare uses revision 0.
Preparation does not authorize implementation. Start requires `run:true` and the
current exact readiness decision. Answers bind saved question IDs. Stable keys
replay saved results; changed payloads conflict. Lost execution acknowledgement
retains the existing dispatch intent and cannot automatically submit twice.
Controls call the same queue as CLI/tracker and carry stable request identity.
The scheduler may retry a pending wake without repeating inference.
Scoped allowance is pinned into implementation metadata after subtracting
preparation charges/reservations and elapsed time. Later runs use the saved cap,
subtract known local charges and completed runtime, and retain the remote
execution ledger's aggregate reservations. Unknown local cost or duration refuses
further dispatch. Providers without billing hard caps remain explicitly described
as such; an authorization limit is not a promise about their billing controls.

Tools are generated from `TASK_OPERATIONS`: capabilities, prepare, answer,
resume, validate, start, list, inspect, evidence, logs and control. MCP SDK
registration prefixes each name with `task_`; there is one schema/annotation
mapping. Preparation, readiness, start and controls are writes with external
effects. Reads inspect saved state and create no provider poller. MCP registration
expects APort's per-request `identityFor` and authorized built `readResource`.
Capabilities return at most 100 authorized repositories, sorted by opaque ID,
with `truncated` and `nextCursor`. Pass `nextCursor` as `cursor` to continue;
a null cursor ends the traversal. Every page reauthorizes the account. Repository
IDs and provider availability, preparation, setup, cost and control fields appear in both
MCP model content and UI metadata, so a client can construct `prepare` directly.
The optional cursor extends operation schema version 1 without changing existing
empty-input calls. Restart discovery to include newly granted IDs before a cursor.

APort owns transport-level OAuth discovery/challenges, origin/audience validation,
credential rotation, request limits, quota, retention and production authorization.

Full UI views include questions, brief, harness/cost/setup, allowance, progress,
bounded logs, artifact IDs/hashes, source snapshots, PR URLs and supported controls.
They remove local paths and redact resolved secrets. Automatic model output is
limited to the capability discovery fields above, task/revision/status/question
IDs and the PR link. Raw logs and brief bytes stay in UI metadata. Artifact download authorization/storage remains APort's
job; the public dispatcher exposes stable manifests, not arbitrary file retrieval.

`uiResourceConfiguration` accepts the single registered `ui://` URI, dedicated
HTTPS origin and exact CSP connect/resource origins. Global sidebar and thread
panel entrypoints share it. HTML is supplied from the built APort UI (256 KiB
maximum), served as `text/html;profile=mcp-app`. Fixture HTML proves resource
wiring only. No final UI or host availability is claimed here.

## Runtime and existing Pages deployment

Node 22 is the supported workflow runtime. Inject `ctx.state`, `gh`, `git`,
`credential`, `identity`, `notify`, `executionFor`, source/brief storage and clock
using the predecessor context contracts. The runtime calls `makeTick` for all
review decisions. Durable home stores registry, tasks, briefs, provider intent,
events and artifacts; neither container disk nor Pages temporary files suffice.
Bounded entry/chain batches run on each externally scheduled wake. Active chains
rotate by a persisted name cursor; done, cancelled and stopped history consumes
no batch slots. Completion or cancellation cannot shift the remaining window.
`maxChains: 0` explicitly disables chain processing for that coordinator. Entry
and chain cursors commit only after a successful tick. The canonical tick's chain
poll deadline is persisted too: pending batches finish their sweep, then chain
reads wait for `poll_seconds` even across process restarts. Faster wakes continue
entry/provider reconciliation without advancing the chain cursor. The next wake
is scheduled before reconciliation, so a crash cannot lose recovery scheduling.

`createNodeOwnerStore({home,durable:true,replicas:1})` uses the existing daemon
exclusion plus persisted monotonic fence/instance. It cannot expire a live owner;
the stale-process check recovers after eviction. A UI or repeated callback never
creates a concurrent owner. Do not share this lock across hosts or advertise it as
a distributed lease. Injected distributed stores must atomically enforce fencing
at their write boundaries. The wrapper guards context effects and retains provider
dispatch ambiguity through the existing execution service.

Before wake-up, migrate/pin the exact runtime artifact. Supply the emitted
`runtime.json` to `createNodeCoordinator({ctx,store,schedule,manifest})`.
The coordinator refuses a different active-job digest. Compatible patches keep
task/provider/brief identities; drain jobs before staging a different artifact.
No running code is silently upgraded. The public API's pre-1.0 compatibility
window is `0.2.x`, with wire schemas all `1`; other versions need migration.

The portable contracts/views/wake envelope have no Node dependencies. The complete
task service and both transport implementations still require Node filesystem,
child processes, Git/gh and isolated verification. Browser-target import rejection
is measured by `test:plugin-package`, separately from actual Node execution. This
is **not** a tested Workers-native workflow runtime or deployed Pages endpoint.
The smallest remedy: keep existing Pages OAuth/MCP/UI; connect its authenticated
runtime binding to one Node 22 coordinator with a durable volume and external
wake-ups. Evaluate an already supported Node runtime or Cloudflare Container in
the existing account before provisioning. No mandatory new Worker/VPS is proposed.

Cloud additionally needs the pinned Codex CLI and trusted operator sign-in. Its
predecessor currently blocks new dispatch until a documented environment-to-repo
check can be implemented/qualified. Preserve that block; native Cloud HTTP,
public credential delegation, cancellation and interrupt are not invented.
Agents API credentials, exact model/environment access and inference/compute
allowance must be supplied by the authorized account; no subscription entitlement
is inferred. Both transports remain exported and covered by installed fixtures.

The inherited registry currently declares **no bounded natural-language
preparation for either hosted provider**. Their `canPrepare:false` and setup
remedy are exposed per configured repository. A task selecting either provider
retains a blocked preparation record with no paid call; it cannot gain readiness
from an invented tool-free mode. The installed full intake/review flow uses the
existing supported local preparation boundary. Separate installed API/Cloud
transport suites exercise implementation/recovery/publication and the hosted
preparation refusal. Full hosted natural-language flows remain unqualified until
an enforced provider preparation adapter and its account access are available.

## Build, configure, upgrade and rollback

Build from the same tagged/merged source and explicit core version. Commit or
remove npm ignore/configuration controls before a public build, including ignored
controls or directories under the runtime payload. Internal builds record these
changes and remain development fixtures:

```sh
npm ci
npm run package:plugin -- --config /private/aport-package.json --out /private/candidate \
  --core-version 0.2.0 --source-commit <40-character-merged-commit>
# For development only, add --internal; keep fixture:true in the config.
task-delivery-package --config /private/aport-package.json --validate-public
npm install --ignore-scripts /private/candidate/gallivant-0.2.0.tgz
task-delivery-state check --home /durable/preview --manifest /private/candidate/runtime.json
task-delivery-state backup --home /durable/preview --manifest /private/previous/runtime.json --out /private/backup
task-delivery-state migrate --home /durable/preview --manifest /private/candidate/runtime.json
# Roll back package AND state into a fresh namespace, then switch the existing binding.
npm install --ignore-scripts /private/previous/gallivant-0.2.0.tgz
task-delivery-state rollback --backup /private/backup --out /durable/restored --manifest /private/previous/runtime.json
npm run test:plugin-package
```

Stop new intake/wake-ups and the old coordinator before backup/migration. Active
jobs retain their runtime; incompatible changes fail with this remedy. Backups
are private, outside public packages, omit operator config/auth, and preserve
task/run/provider/source identities. Back up with the currently pinned, pre-upgrade
manifest; a candidate manifest cannot label an older namespace's backup. Restore
requires both the backup envelope and copied runtime pin to match the selected
artifact. Unpinned legacy state can be backed up with an explicit compatible
manifest and must be migrated before enabling its coordinator.
Verify store consistency before switching bindings. Keep old runtime artifacts
and credential bindings available for rollback; do not merge/upgrade live jobs.

Package config supplies publisher `APort`, exact endpoint, `resource` configuration,
owner-selected support email/product/support/privacy/terms/license URLs and explicit
asset paths (`assets.ui`, `assets.icon`, `assets.screenshots`). The emitted combined
skills/MCP ZIP has one HTTPS MCP server, Apache-2.0 license and explicit assets.
Runtime tarball, recipe, operation schemas and manifest record source commit,
core/contracts, dependency lock, payload/asset/schema hashes and artifact SHA-256.
The published runtime carries `npm-shrinkwrap.json`, so the installed builder
uses the same dependency lock as the source build.
No credential headers or unrelated tree files enter the plugin. Keep input config,
private backups, provider logs and reviewer credentials outside the output.

The configuration shape is:

```json
{
  "publisher": "APort",
  "endpoint": "https://aport.io/api/task-delivery/mcp",
  "fixture": false,
  "supportEmail": "<owner-selected support email>",
  "homepage": "<owner-selected HTTPS product URL>",
  "supportUrl": "<owner-selected HTTPS support URL>",
  "privacyUrl": "<owner-selected HTTPS privacy URL>",
  "termsUrl": "<owner-selected HTTPS terms URL>",
  "licenseUrl": "<owner-selected HTTPS license URL>",
  "resource": {
    "uri": "ui://task-delivery/app",
    "domain": "https://aport.io",
    "connectDomains": ["https://aport.io"],
    "resourceDomains": []
  },
  "assets": {
    "ui": "/private/aport-ui/task-delivery.html",
    "icon": "/private/aport-ui/icon.png",
    "screenshots": ["/private/aport-ui/actual-host.png"]
  }
}
```

Replace every placeholder and bind the actual built UI's exact origins. This
shape alone does not prove deployment or supply final assets. Public packaging
also requires a clean source payload and verifies the requested source commit
against HEAD. Internal dirty builds record their changed payload files and hashes.

Public validation refuses absent metadata, example URLs, unavailable built UI,
fixture assets and missing screenshots with remedies. A structurally valid
package remains `public-candidate-unqualified`, never submission-ready by itself.
Rebuild executable/configuration changes and invalidate affected evidence.

Official formats rechecked 2026-10-07: [portable packaging](https://developers.openai.com/plugins/build/plugins),
[UI resources](https://developers.openai.com/plugins/build/chatgpt-ui),
[global/thread entrypoints](https://developers.openai.com/plugins/build/extensions),
[submission](https://developers.openai.com/plugins/deploy/submission).
Vendored portable JSON schemas retain their source URLs and recorded hashes.

## M6 handoff gates

M5 artifact tests are deterministic and unpaid; they are not actual host evidence.
M6 pins the **human-merged** artifact/digest into the existing APort job, verifies
real Pages/runtime/bindings/durable storage, and reconciles PR #414's deployment.
The 2026-10-07 endpoint probe returned HTTP 503. This session had no configured
Agents API credential/model/environment; pinned Cloud listing was accessible but
proved neither environment repository nor inference access. Browser/capture
inventory was available, with no task-delivery tool installed in this session.

Mandatory remaining gates: actual endpoint OAuth discovery/tool scans and scoped
account isolation; both providers' real implementation and correction PRs across
restart; public Cloud mode only if delegation is demonstrated (otherwise trusted
operator mode); actual sidebar/panel and fresh-account reconnect; restricted
reviewer account with shared campaign allowance; authentic screenshots/demo;
working legal/support pages; eligible publisher project/org/domain verification;
bounded G9 kit with five positive/three negative cases. APort is publisher. No
release approval, submission, deployment or publication is claimed by M5.

### Model-visible discovery and evidence

`list` accepts an optional saved task ID as `cursor`, returns at most 100 authorized
tasks in ID order, and supplies `nextCursor` when `truncated` is true. Every page
uses current account and repository authorization; a cursor grants no access.
MCP evidence responses expose bounded artifact IDs/hashes, provider test claims,
coordinator verification observations and the PR link. Log responses expose the
saved window range, count, gap and `nextAfter`, while raw log text and briefs remain
in authorized UI metadata. Neither read operation starts provider reconciliation.
