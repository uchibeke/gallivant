# Release qualification audit

This is a partial implementation handoff, not a completed release or submission
candidate. The [frozen PRD](../../prds/gallivant-plugin-release.md) and its carried
sources were read and remain unchanged. [Release commands and exact remedies](../../release-qualification.md)
describe the existing package/runtime and opt-in verification workflows.
[The evidence index](release.json) separates offline checks from actual observed
service responses. No fixture is recorded as a live pass.

The source reuses the existing package builder, payload allowlist, task/provider
services, G8 drivers and state migration tools. It adds bounded assembly,
preflight, candidate-bound evidence checks, explicit stale-check selection and
separate lifecycle states. Source review covered the build/validate/live callers,
artifact and source inputs, symlink/traversal boundaries, record serialization,
occupied-output preservation and cleanup. A sibling observation-validation defect
was fixed in publication-state bindings; no private credential strings are emitted
as evidence. Regression coverage uses an actual emitted fixture ZIP and runtime
package but never calls those a host installation or public release.

Observed on 2026-10-18:

- M5 PR #12 merged at `6cc15a85ba3cb10a09711439e4b6e8aaef1ebf16`.
  Foundation PR #414 merged at `a1a84beead7b58c2124a7f483c5eaf4ea6c97b98`.
  The operator registry identifies both jobs as `done`. Foundation base is
  `staging`; no job with the required successor identity was present.
- Connected-runtime PR #425 also merged to `staging`, at
  `e71a8fef74147fef65013df1b47c49122cb1fd64`. Reconcile this shipped work and
  `_plans/task-delivery-contract.md` (observed Git blob
  `2c5fe33191f4179516e655ca16dac5f32bcd93b6`) before any necessary successor.
  A merged foundation or later integration PR is not functional qualification.
- Native preview capabilities expose only
  `aporthq/task-delivery-onboarding-qualification`, a USD 2 per-task allowance and
  Agents API configured but account/model access unverified until setup. Cloud
  reports unavailable because its supported environment-to-repository check is
  missing. This connection does not expose integration-repository job controls.
- The existing sample task `task-7cc1e513da80002d0f211601` is revision 6,
  blocked/cancelled. Its saved implementation observation reports a test pass at
  `ee87f27bc1839c7d9be64ba6f25e6caf12604e2e` and PR #1 in that sample repository,
  but completion does not match, all nine criteria are unmet, and cost is unknown.
  It was inspected, not resumed or replaced. This is historical preview evidence,
  not evidence for the new candidate.
- The public MCP route responds to GET with 405. Its protected-resource metadata
  path responds 200 JSON. These are route observations only, not authenticated
  OAuth, tool-schema, durable restart or artifact-download qualification.
- Browser/capture inventory includes Chrome and a ChatGPT tab. No exact release
  candidate was available to install there. Preview tools working in this session
  do not establish actual ChatGPT sidebar/panel support for that candidate.
- Both existing G8 preflights report absent private HOME, PRD, REPO and campaign
  ledger variables. The carried USD 10 aggregate authorization is known; its
  remaining balance/reservations are not reconciled here. No paid calls were made.
  Cloud help used the exact configured executable and exposed only exec/status/
  list/apply/diff; help is not model/environment/repository access evidence.

Required external continuation is concrete: reconcile the one shared ledger and
unknown previous usage; provide the actual selected model/environment and
restricted repository configuration; qualify Cloud's supported mapping at its
adapter; rebuild/pin merged M5 bytes with APort's actual UI/metadata; reconcile
#414/#425 and any necessary single successor; obtain human merge and qualified
runtime deployment before host tests. Then perform fresh reviewer/host scenarios,
record publisher/org/project/domain/scan outcomes, capture authentic media and
assemble the public G9 kit. The prior work is preserved; no new integration job,
paid dispatch, deployment, merge, portal submission or publication occurred here.

Initial broad tests failed inside the outer sandbox on process identity and native
sandbox enforcement. A supported automatic approval allowed the minimal host
probe, which passed `sandbox-exec` filesystem/network enforcement. Required suites
were then rerun with that host capability and the product's isolation intact.
The index records final outcomes; initial failed logs are retained separately.

Final offline checks passed: 1,720 full-suite passes (one existing skip), 418
backend passes, 43 installed flows plus 534 installed conformance checks, eight
release checks including a fresh tarball-installed validator, lint and whitespace.
The record validator uses the existing canonical JSON helper, so key reordering
and audit-only changes do not unnecessarily invalidate unchanged candidates.
These results do not qualify the live release; twelve acceptance criteria remain
unmet as recorded in the evidence index.
