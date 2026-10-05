# Hosting and live-test decisions, 2026-10-04

This is a later operator decision for the unstarted milestones of
`plugin-ready-gallivant`. It supersedes the earlier shared contract's statements
that the hosting repository and API-test authority are unknown. It also clarifies
that a separate always-running server is not a product requirement. It does not
change the running natural-language task or weaken any live release gate.

## Confirmed direction and bounded testing

Uchi selected the existing `aporthq/agent-passport` Cloudflare Functions deployment
as the public endpoint location and authorized API testing. Use a proposed
`https://aport.io/api/gallivant/mcp` route, with a matching sandbox route under the
existing preview origin. The path is an implementation choice, not a claim that
it is live or domain-verified. Keep APort as publisher and reuse its legal URLs.

Use an initial **USD 10 aggregate API-test allowance**, chosen conservatively by
the implementing assistant within the user's general testing authorization; Uchi
did not specify this numeric limit. Count API inference and hosted sandbox charges
across these milestones together, not USD 10 per test or PR. Run one small task and
one forced correction per remote backend, plus necessary installed-host coverage.
Reuse valid evidence for an unchanged candidate; repeat only affected checks after
a fix. No benchmark campaign or open-ended agent loops. Codex Cloud's account
allowance is distinct from Agents API charges.

Record a single campaign ledger outside public packages with priced estimates,
reserved amounts, provider-reported usage, attempts and remaining allowance.
Validate current pricing and enforce available output/turn/time/compute limits
before dispatch. Refuse another paid operation if its bounded reservation would
exceed the remainder or cannot be established. Cancel unused resources promptly.
Delayed usage reporting is not a guaranteed hard provider billing cap; disclose
that limitation and stop on unknown uncontrolled spend rather than treating it
as zero. Do not change global model defaults or buy credits automatically. Ask for
a higher allowance only if the concrete remaining test cannot fit. Credentials,
account access and a disposable authorized repo are still real prerequisites.

This authorizes the bounded live API checks, not recurring hosting subscriptions,
new paid infrastructure plans, automatic merges or public directory submission.

## Endpoint and coordinator boundary

Audited `agent-passport/wrangler.toml` already defines a Pages build from `web/out`,
Functions, D1/R2/KV and a service/Durable Object binding to
`agent-passport-do-worker`. Its current compatibility date is `2024-11-15`; Node
compatibility is enabled. No Container, Queue or scheduled-trigger configuration
was found in the inspected root and worker manifests. These observations are not
proof of which optional products the Cloudflare account has enabled.

Implement a thin Pages endpoint for the MCP transport, authentication/discovery
and access-controlled routing. Preserve streaming, session and authorization
headers, origin/audience validation and request limits. Backend destinations come
from trusted deployment configuration, never tool input. Do not trust caller-set
identity headers or expose an unauthenticated internal coordinator. Use existing
account code where suitable, but APort login alone is not MCP OAuth compliance.

Gallivant owns task/readiness/review/PR logic and its versioned package. Hosting
does not mean hosting the coding model. The cloud harness does the implementation;
Gallivant saves task state, reconciles provider/GitHub changes and dispatches
bounded follow-up work. That coordination can be event-driven rather than an
always-running process. A scheduled Worker or Durable Object alarm can wake the
same portable core, perform a bounded reconciliation and persist the next action.
One fenced state owner remains necessary even when no process stays resident.

The current coordinator uses Node child processes, Git/gh, local files and watching;
Workers' Node compatibility does not make that implementation run unchanged.
Evaluate the two execution paths separately. Agents API can use network requests
from Workers, but the surrounding state, GitHub transport, credential resolution
and scheduling must also be compatible. Put those platform operations behind
shared interfaces; preserve one decision/review implementation. Do not copy the
daemon into a function, hold a request open for the entire job or reimplement a
second orchestration engine under the name of a serverless adapter.

Codex Cloud's currently supported integration still requires its CLI on a trusted
Node-capable worker. An HTTP-only Cloud dispatch path requires official evidence;
do not invent one to remove that dependency. Preserve both harnesses and label
which runtime/setup each needs. A self-contained public Agents API path can ship
alongside an operator-configured Cloud worker without requiring public users to
leave a laptop on.

Prefer the existing Cloudflare account and the least duplicated implementation.
The deployment milestone must demonstrate whether the shared core can run on
Workers with durable scheduling/storage for the API path. If preserving current
Gallivant behavior requires a Node runtime, document that specific constraint and
evaluate Cloudflare Containers behind a binding, using the same package. Do not
mandate a new VPS or claim a full Workers-native port already exists. Verify
availability, persistence and cost before provisioning either option.
Container disk and Pages temporary files are not durable registry storage.
Demonstrate persistent dispatch intent/state, single-owner fencing, crash recovery,
wake-up/reconciliation while no browser is open, artifact retention and no duplicate
paid dispatch after eviction. Graceful-shutdown snapshots alone cannot protect
against a crash. Do not duplicate the review loop inside a Durable Object or
claim a bare proxy endpoint meets the hosted release requirement.

Preserve production isolation: existing `TenantDO` is shared by preview and
production. Do not mix Gallivant execution state into its counters or change that
worker protocol casually. Use explicit environment bindings and separate state
namespaces; verify the deployed entrypoint and both rollout orders. Read the
target repository's current `AGENTS.md`, configuration and deploy workflow for
actual implementation; do not copy its whole policy into Gallivant.

## Repository and release handoff

Gallivant M5 owns the reusable service/package, Cloudflare deployment artifact and
a concrete integration contract for the agent-passport endpoint. Produce a small
downstream endpoint PRD/handoff using the stable built API and package digest.
Agent-passport owns its route, bindings, OAuth integration and deployment wiring in
a separate PR; use an isolated checkout, preserving unrelated local changes.

M6 owns that integration dependency through to a real endpoint: dispatch the
endpoint brief through the existing authorized Gallivant start workflow when its
core prerequisites exist, record/reconcile the child job and PR, and wait for the
human merge/deployment before installed-host qualification. The current chain
supports one repository; do not pretend it automatically chains that second repo
or build another runner to bridge it. If the execution environment lacks operator
control access, surface the exact existing start command and dependency instead
of reporting the endpoint implemented. Keep one implementation PR per repository.

The original G7 Node deployment wording is a valid reuse option, not a requirement
to purchase a separate server. G7's durability, single-owner and recovery outcomes
apply equally to a proven event-driven deployment.

M6 cannot finish with only a proxy stub, generated integration patch or instructions.
The candidate must actually work at its verified public endpoint with persisted
jobs, real provider tests, reviewer access and the complete G9 submission bundle.
Use an opt-in preview deployment first and the target repo's normal release flow;
new paid infrastructure or unresolved publisher actions remain specific operator
decisions. Do not weaken the endpoint's production authentication for testing.

## Sources verified on 2026-10-04

- [Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/): Pages can bind services, storage and an independently deployed Durable Object worker.
- [Workers Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/): inspect actual supported APIs, not just the compatibility flag.
- [Workers filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/): temporary files are not persistent cross-request state.
- [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/): stop/restart and ephemeral disk require explicit persistence and recovery.

Canonical local hosting sources are in `../agent-passport/` relative to Gallivant:
`AGENTS.md`, `wrangler.toml`, `do-worker/wrangler.toml`, `do-worker/src/index.ts`,
`functions/`, and `.github/workflows/deploy.yml`. These are implementation references;
the facts and decisions needed by remote milestone checkouts are carried here.
