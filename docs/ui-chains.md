# Chain workspace

Open **Chains** in the workspace navigation. When no chain is specified, the first
matching chain is selected: active chains first, then stopped, completed and cancelled,
with most recently updated first within a status. Its selection is pinned in the URL
so refreshes do not move the workspace beneath you. Choose another chain as needed. The ordered
list shows the selected milestone, its predecessor gate, and links to its task
and recorded PR. `/chains` and mounted `/gallivant/chains` URLs retain chain
search/status filters, list pages, theme and the selected milestone across task
navigation, reload and browser history. A missing chain or milestone is explained
without silently selecting a different chain.

Only the chain service's saved merge receipts count as integrated dependencies.
Delivery readiness, an ended worker, closed unmerged PRs and cancelled future
dispatch have separate labels. The next gate comes from `chainRows` and saved
chain reasons; no page read queries a host or starts work. A registered `--after`
predecessor remains a separate gate. Its PR is linked without adopting its run.

## Recover future work

**Review retry** uses the existing stopped-chain retry service. **Review changed
inputs** explicitly reads the candidate ready briefs and approved host base, then
shows old/new input fingerprints, harness identities and local/base file fingerprints.
The full input fingerprint includes repository, checkout, approved base, brief
and carried source bytes. File contents are never saved here. Older chains lack
individual local source hashes; inspect content changes in the repository before
accepting a replacement. The UI does not expose file bodies, checkout paths, dispatch
secrets or protected source names. Repository, task and approved base identities
cannot be replaced through this operation. Task delivery targets are shown from
canonical completion evidence when available; chain dependencies always require
a merge into the approved base.

Confirmation recomputes the candidate and rejects changed inputs, chain state or
base files. Nothing is accepted by opening the page or requesting a review.
Retries do not resume workers or reset budgets. **Review cancellation** stops
future chain dispatch and preserves existing runs, including an active worker.
Use the task workspace separately to control an existing worker. New chain
creation remains in CLI intake.

Unavailable controls explain their gate: terminal chain, unresolved start claim,
no undispatched work, nonlocal access or artifact-pinned namespace. Changed-input
review is bounded to 25 undispatched milestones; larger approval sets use CLI
review. Ordinary retry and cancellation still have their usual service scope.
If confirmation loses its response, do not repeat it: refresh and inspect the
last saved request identity. An exact duplicate request observes its receipt
without applying the service again; stale revisions cannot authorize new work.

## Transport and qualification

`POST /api/chain/control` has `review` and `confirm` stages for `retry`,
`resnapshot` and `cancel`. It shares the run-control loopback peer, Host, origin,
CSRF token, bounded JSON and mutation-lock boundary. Requests carry the exact
reviewed revision and a request identity. It delegates to `retryChain` or
`cancelChain`; no scheduler or worker endpoint is added. Existing CLI calls keep
their behavior. Additive local input hashes and the last-control receipt need
no state migration.

One lifecycle-managed read controller refreshes `/api/chains` every ten seconds,
without overlaps or event subscriptions. Hidden pages pause; navigation aborts
reads. Three failures pause automatic retries and retain a visibly stale last
good snapshot. Updates wait while focus, disclosures or scroll would be disturbed.
Lists render at most 20 chains and 25 milestones, plus the selected detail.

`test/ui/chains.test.mjs` exercises real served pages and protected POSTs with
synthetic state and fake host boundaries. It covers both mounts, history, merge
counts, changed inputs, retry/cancel scope, polling bounds, both themes, keyboard,
accessibility, 360/390/768/1280/1440 widths and mobile landscape at 200% zoom.
`test/chains.test.mjs` and `test/tracker.test.mjs` cover exact revision/replay,
identity, locking and authorization failures. `npm run test:install` checks
routes and assets in the installed tarball; browser tooling and fixtures are
excluded from the runtime package.

Approved captures use Chromium, fixed fixture time, device scale 1, desktop
1440 × 1000 in dark theme and mobile 390 × 844 in light theme:

```sh
node test/ui/capture.mjs chains-desktop
node test/ui/capture.mjs chains-mobile
```

See [desktop](ui/previews/chains-desktop.png) and
[mobile](ui/previews/chains-mobile.png). These are rendered synthetic fixture
captures, not production activity. Revert the chain UI and thin adapter to roll
back. Existing chain scheduling and CLI recovery remain unchanged.
