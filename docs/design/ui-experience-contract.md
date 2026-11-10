# UI experience contract

This is the shared, immutable requirements input for the UI experience chain.
The nine implementation briefs and their order live in
[the chain plan](../plans/ui-experience-chain.md). Read this with the current
implementation, not as a claim that the redesign has already shipped.
Lookout is deliberately absent from implementation scope; its brief will be
written only after this chain is accepted.

## Product outcome

An operator returning after hours away can answer, in one screen: what needs my
decision, what is progressing, what is waiting on an external system, and what
has actually finished. The experience must be a substantial redesign of layout,
hierarchy, navigation, interaction and presentation, not a recolored table.

Use an attention-first operations workspace: a calm graphite dark theme and a
crisp warm-neutral light theme, layered surfaces, clear typography, restrained
cyan emphasis compatible with existing host tokens, amber attention, red failure
and green verified success. A subtle highlight can identify focus or active work;
constant pulsing, low-contrast glass, giant empty hero cards and decorative charts
cannot substitute for useful information. Preserve existing theme parameter and
host custom-property overrides. Use system or already bundled fonts and one
consistent local SVG icon vocabulary; no font/CDN/analytics requests.

## Architecture and reuse

The existing server-rendered ESM architecture remains the starting point.
Keep transport and protection in lib/commands/serve.mjs, pure presentation
projections separate from state mutation, HTML composition in focused tracker
modules, shared styles in templates/tracker, and small browser controllers for
interaction. Split the large page/script files by responsibility when touched.
Do not introduce a SPA/framework migration, parallel daemon, second task store,
provider-specific screens, or another design system.

Derive task and delivery facts from existing taskView/completionView,
coordinator observations, review projections, chainRows, capability declarations
and controlAvailability. Extend shared read models additively only where a
required fact is missing. Renderers and the browser cannot certify completion,
decide budgets, infer review verdicts from prose, recompute provider support,
or authorize a start. Never turn missing data into zero, green or completed.
The CLI, API, embedded and standalone presentations must agree on the same facts.
No task/execution state-schema migration is needed for a visual redesign.

The browser is a presentation/control client. GETs do not launch probes, models,
Git operations, jobs or recovery. Use canonical service methods for approved
mutations, with the same ownership, revision, request identity and permission
checks as other callers. Reuse the existing protected control route; never send
shell commands from the browser. Any new task/chain HTTP adapter must be thin,
loopback protected, revision bound and tested against its existing service.

## Information hierarchy

Global navigation covers Overview, Tasks, Chains, Run history and System health
as those destinations become implemented. Never enable a dead destination.
New task is a clear entry action, not an implicit model call. The existing
root/run/runs URLs remain valid. Browser back, reload, copied links, filter state
and the selected historical run must behave predictably.

A task summary and task workspace show:
- identity, repository, approved base and delivery target;
- current phase and the specific blocker, responsible actor and next action;
- last meaningful activity separately from last observation and snapshot freshness;
- harness/provider/model only when recorded, with honest unknown/unavailable states;
- PR or other delivery, current-head CI, external/independent review, acceptance
  and owner-delivery evidence, distinguishing their statuses and provenance;
- active attempt, elapsed duration, rounds/limits, retry schedule and chain position.

Worker exit, delivery readiness, integration and closure without integration are
different facts. A pending readiness refresh is not failed authentication.
No CI configured, CI not observed and CI passed are different states. Old-head
reviews cannot clear a new head. A skipped acceptance gate cannot display as a
pass. Readiness, errors and identity/brief changes must remain visible even when
another process is running.

Use ordinary user language first, with an expandable technical reason/code,
evidence pointer and relevant CLI remedy. Keep immutable source details available.
Never invent an ETA, cost, progress percentage, event, empty token count or
provider guarantee. Costs and usage expose their source and unknown totals.

## Controls and safety

Message agent is a separate composer: it sends a correction/context update to
the current logical task. It does not silently edit the approved brief, start
another task or bypass changed-brief approval. Interrupt is explicit and off by
default; explain preservation of unfinished files and the interruption cost.

Resume agent continues authorized work after the shown prerequisite is repaired.
Recheck PR refreshes PR/review/check observation; it neither resumes an agent nor
reruns CI. Cancel task remains a separate destructive action with an accurate
confirmation and cancellation-confirmation status. Never add bulk dispatch,
merge, deployment or credential entry as incidental UI affordances.

Show available, unavailable, queued, applying, applied, failed and uncertain
states with truthful explanations. Applied means the coordinator applied the
request, not that the model acknowledged it or the task completed. Preserve
draft text, focus and scroll during updates; scope drafts to the task/instance
and never persist tokens or credentials. Replay an uncertain request only under
the same supported operation identity after observing saved status. Never create
a duplicate paid job because a browser timed out.

## Responsive, accessible and observable

Support 360, 390, 768, 1280 and 1440 CSS-pixel widths, plus mobile landscape,
200% zoom, keyboard-only operation, long paths/text and both themes. Keep primary
controls about 44 CSS pixels or larger on touch screens; provide visible focus,
landmarks, labels, keyboard alternatives and restrained live announcements.
Meet WCAG 2.2 AA contrast and interaction requirements. Respect reduced motion.
Logs/code may scroll inside their own region; the page must not overflow.

Distinguish connecting, current, stale, disconnected, empty, permission-limited
and error states. Keep the last good snapshot visible and clearly stale during
a read failure. Show the last observation time and a bounded retry action.
Use one lifecycle-managed refresh/stream controller per active surface, never
overlap requests, clean up on navigation and pause/back off when hidden or
disconnected. Polling must not rewrite meaningful-activity timestamps.

Page/window large task and event collections. Qualify 1,000 tasks and 10,000
historical events with bounded visible rows and the existing cursor/tail
mechanisms. Never load all transcripts into the DOM or add per-row host queries.
Use request/DOM/resource bounds as deterministic tests; record timings with
environment details rather than fragile universal wall-clock assertions.

## Delivery and proof

Milestone 1 establishes one reusable browser fixture server and npm run test:ui.
Use repo-owned synthetic state, a controlled clock and fake service boundaries.
No production credentials, paid inference, real email, real job cancellation or
special ChatGPT/desktop connection is needed. Fixtures must be identifiable as
fixtures in documentation and must never become fabricated production rows.

Use a dev-only browser driver, preferably Playwright, reusing existing tooling
where possible, and an automated accessibility check. Keep browser downloads,
test code and fixtures out of the published runtime package. CI must exercise
actual served pages, scripts, styles, events and protected POSTs; do not prove a
working interaction with a stubbed DOM or screenshot alone. Both root and
/gallivant mounts, query parameters, APIs and standalone/embedded use are gates.

Each visual milestone publishes only its exact approved product PNG captures.
Capture the rendered product in a real headless browser, inspect the images,
and fix clipping, spacing and state defects before claiming the milestone.
Use the same fixtures for before/after comparisons; do not fabricate or edit a
capture to imply behavior. Other diagnostics and full traces stay in private
temporary storage or CI artifacts, not task logs committed to Git.

Pixel comparisons use a qualified pinned CI browser/font environment; cross-OS
font differences are not proof of regression. Semantic, geometry, keyboard,
security and accessibility checks must also pass. Final qualification includes
Chromium, Firefox and WebKit smoke flows, with Chromium visual references.
Retain the existing runtime portability matrix and release guards.

Update durable operator/maintainer docs as features ship, including empty and
recovery states. All new routes, shared assets and links must work in an actual
packed installation. No live service, account change, deployment, auto-merge,
global plugin change or Lookout integration is authorized by this chain.
