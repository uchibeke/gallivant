# Dependency delivery qualification

The qualification command evaluates the composed dependency planner and factory
workspace. It binds the checkout commit and tree, actual code and test bytes,
package and lock digests, UI inventory, Node, OS and architecture. The report
records the current graph, approval, projection, registry and plan store formats.
The live matrix identifies the host, visibility, author harness and each evidence
owner. Author capability fields describe the shipped adapter. The proof columns
describe independently observed results for specific admissions.

| Evidence | What a passing check covers |
| --- | --- |
| Fixtures | The compiler, admission, dispatch, controls and projections, plus the shared chain, review, publication, resource and cleanup contracts. |
| Served browser fixtures | The actual tracker routes and assets, with a synthetic registry, operator and effect owners. Both the plan and task workspace suites must pass. |
| Native | The exact Linux or macOS coordinator environment, including owned process exclusion, cancellation, journal replay, cleanup, supervisor and verification isolation. |
| Live | The exact disposable repository, runtime, author and reviewer routes, and the independently authorized maintainer. Each required combination has its own receipt. |
| Unvalidated or gated | A missing proof stays unvalidated. Codex Cloud stays gated for new dispatch and can observe already bound work. |

Each required combination pairs Linux or macOS with GitHub, private Bitbucket
Cloud or public Bitbucket Cloud and an author adapter that advertises a compatible
dispatch path. This includes the five local harnesses and the hosted Agents API
snapshot route. Every row starts unvalidated. A host or route that lacks approval,
isolation, model access or effective allowance enforcement remains gated. Proof
for an author route cannot establish first-party review, verification or the
behavior of another installation. See the [current feature inventory](ui-feature-matrix.md).

## Fixture aggregate

From the source checkout with development dependencies and the pinned Playwright
Chromium installed, run the opt-in aggregate.

```sh
node scripts/qualify-dependency-plans.mjs --fixtures
```

The command prints the test output and a final JSON report. It fails when a suite
is missing, timed out, failed, skipped or incomplete. The served tests use loopback
pages at the root and under a mount. They check narrow and wide layouts, both
themes, landscape, 200% zoom, keyboard access, reduced motion, axe, selection and
refresh, and capture a synthetic PNG. GET and refresh are measured against saved
state and host/model calls. Explicit previews may read bound host inputs. They
leave the registry unchanged and send no execution requests.

The report includes compile and paged projection sizes for a 1,000-node graph.
The dispatch fixture uses 15,000 retained tasks, three graphs, a 48-hour
Retry-After and a restart between eligible cycles. It records registry
replacements and bytes, wall-clock cycle time and simulated eligibility-to-start
queue percentiles. These are fixture measurements. Live throughput and capacity
depend on the admitted hosts, author and reviewer routes.

## Protected native and live checks

The operator selects an existing disposable qualification task with a protected
recovery profile. The profile pins a canonical `evidenceRoot`, an approved
`manifest:NAME` reference and its canonical JSON SHA-256 digest. Save that
manifest as `manifests/NAME.json` within the protected root. Admit the specific
actions `verify-disposable-isolation`, `qualify-native`, `qualify-live` and
`check-evidence` that the deployment needs. Use a dedicated root for this
manifest and preserve it with the independent owner records outside Git.

```sh
export GALLIVANT_QUALIFICATION_TASK='ORG/REPO/TASK'
node scripts/qualify-dependency-plans.mjs --native
node scripts/qualify-dependency-plans.mjs --live
node scripts/qualify-dependency-plans.mjs --check-evidence
```

The version 1 manifest has purpose `disposable-synthetic-dependency-plans` and
contains `artifact`, `limits`, `signers` and `cases`. Use the exact artifact
from the fixture report. The limits specify the start, expiry, evidence expiry,
total paid turns and spend. Each case binds the operation, route digest,
runtime fingerprint, launch digest and its own deadline and allowance. Native
case IDs are `native-linux` and `native-darwin`. Live IDs are
`live-PLATFORM-SURFACE-HARNESS` as listed in the generated matrix. Every live
case requires a native case for its exact coordinator environment.

A live case pins the repository identity, visibility, immutable host ID and
credential reference. It also pins the graph and approval digests, a legacy
chain endpoint and its frozen contract, and the diamond's four node IDs. The
producer and each of the four leaves have their own exact task and operation
digests, disposable head, head/base commits and static patch digest. Pin the
external reviewer, first-party review route and separately authorized maintainer.
Use only already approved disposable refs and effects. Keep production scopes
outside this qualification profile.

For missing cases, the trusted coordinator embedding passes its context to
`dependencyQualificationCommand` and binds the existing
`disposableQualificationOwner`. Its read-only `baselineFor` supplies the pinned
launch and a supervisor-signed `launchReceipt` tied to the exact case. The live
prerequisites include proof of actual model calls on the selected author and
review routes, the installed plugin behavior, host binding, allowance enforcement
and capture when required. Version and sign-in diagnostics establish installation
and authentication only. Run the smallest authorized probes in the selected
environment before admitting effects. An owner may bind a separate native host
through its trusted port. The local native probe runs only on the matching OS,
architecture, Node version and trusted `qualificationEnvironmentDigest`.

The runner verifies the fixture certificate first. Live also requires all
native receipts. It preflights every missing case in a phase before running any
case, then calls `reconcileCase` with the original operation key. Use the provided
`beforeEffect` callback at the existing owner boundaries. An unknown submission
or lost reply keeps its original operation. Merge authority stays with the
independent maintainer. The host proves each exact merge and ancestry, and the
coordinator proves attachment before the final producer PR, sibling eligibility,
and release of one join after both sibling integrations settle.

## Read-only evidence check

Independent Ed25519 keys sign the canonical SHA-256 digest of each record. The
protected manifest pins separate public keys for its owners. The fixture owner
signs `fixtures.json` after observing the aggregate exit, suite results and
report digest. Each `cases/ID.json` contains signed step envelopes bound to the
manifest, admission, artifact and full case. Observations reference canonical
records held by those owners. `aggregate.json` signs the fixture certificate
digest and the complete map of case receipt digests. The exact fields and facts
are defined in `lib/dependency_plan_qualification.mjs` and the existing
qualification evidence contract.

`--check-evidence` only reads and verifies those files. Missing, stale,
substituted, unsigned or partial evidence exits nonzero. Restore the exact
approved manifest, owner proof or signed receipt before retrying. Qualification
results leave production authorization with the protected deployment and the
operator. [Rollout and rollback](dependency-plans.md#rollout-and-rollback)
