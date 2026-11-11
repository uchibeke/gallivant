# Task presentation contract

`lib/tracker/presentation.mjs` projects saved observations into the additive
`presentation` field on status rows and task delivery views. Overview, task
detail, CLI text, model summaries and task list summaries consume these same
facts. Existing state codes, identifiers and canonical API fields remain
available; presentation labels are not lifecycle transitions.

| Fact | Authority and provenance |
| --- | --- |
| Readiness, delivery target, integration | `completionView`; exit zero and a legacy ready/done state cannot supply missing delivery evidence. |
| Receipt | Canonical completion or `gate_skipped`; unknown and skipped are distinct from accepted. |
| Independent review | `reviewActivity` with the saved review binding and head. Old-head evidence remains historical. |
| CI and external review wait | `reviewObservation`, recorded by the coordinator from its existing check/review decisions; tied to head and binding. |
| Provider readiness | Saved provider-health observations and declared capabilities. Pending refresh, quota, credentials, unsupported dispatch and unchecked API access remain distinct. Read access never proves inference access. |
| Controls and ownership | `controlAvailability` and execution ownership. Ended but unreconciled runs and uncertain cancellation disable writer controls; requests still use the protected canonical service. |
| Meaningful activity | Recorded task/run/review/control-result event instants, with source pointers. Routine `updated_at` and provider poll times only affect freshness. |
| Attempt duration and rounds | The selected run's timestamps and matching current registry accounting. Historical rounds without matching accounting remain unknown. |
| Chain position | Existing chain summaries plus each registered step’s index; all recorded members retain their position. |
| Attention | Shared attention projection of divergence, controls, review disposition, phase and canonical readiness. |

Planning and brief validation use typed preparation states. An active matching
implementation run establishes that an agent is working, but does not establish
its finer phase. Transcript prose is never searched for phases or verdicts.
Missing or malformed observations produce bounded diagnostics and unknown
values; no timestamps, percentages, usage, costs or ETAs are invented.

Control status polls include fresh canonical availability. When a queued or
applying request settles, the composer and action buttons use that snapshot,
preserving failed messages for editing while unresolved ownership keeps writer
controls disabled. Snapshot freshness may advance between API reads or operation
replays without changing meaningful activity.

Selectors accept values, not contexts or service clients. They do not read files,
probe providers, query hosts, dispatch work or write state. Existing adapters
collect saved facts before calling them. The coordinator's bounded
`reviewObservation` is optional for old records and introduces no schema migration.
Arbitrary provider messages stay out of summary diagnostics. HTML escapes values;
task delivery views additionally apply their existing scoped secret redaction.

The [overview](ui-overview.md) renders at most 25 tasks per page and preserves
filters and theme in navigation. The task workspace sidebar retains its 100-row
window. The existing status API retains its complete
row collections for compatibility. Run history keeps its existing 200-row limit.

Regression coverage lives in `test/tracker-presentation.test.mjs`, the existing
status/completion/control tests, and `test/ui/browser.test.mjs`. Browser tests use
the foundation's synthetic fixture server at root and mounted paths, including
API/detail agreement, malformed review records, unresolved execution and 1,000
tasks. They do not establish live provider/model access. Overview-specific
coverage and capture provenance are documented in the overview guide.

Rollback consists of reverting the presentation changes. Older versions ignore
the additive observation; no task data migration or budget/policy reset is needed.
