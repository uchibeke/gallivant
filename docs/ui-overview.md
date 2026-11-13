# Task overview

The overview uses the shared task presentation model and defaults to newest
meaningful activity first across every status. Poll freshness does not move a
task up the list. Missing activity dates sort last, with stable task-ID ties.
Choose **Needs attention first** in **Sort tasks** to group decisions and repairs
before readiness, progress, waits and recorded outcomes.

**All tasks** and the status filters show one clearly selected link. Counts follow
other active search and filter choices. **Completed** includes tasks recorded as
`done`, integrated deliveries and closed outcomes. This lifecycle label does not
certify missing acceptance or review evidence: a legacy completed task can still
show unverified delivery. Active or unresolved execution ownership takes precedence
over a saved done flag. Genuinely unclassified observations remain **Unknown**.

Each compact record shows the repository, task, phase, harness, meaningful
activity age, delivery/check/review evidence, round usage, and recorded chain
position. Expand **Context & next step** for the explanation, responsible actor,
approved base and delivery target, activity and observation times, attempt
information, and task links. The PR link stays visible on the record and opens in a new tab. **Technical reason & evidence** exposes the
saved reason and provenance. The task workspace retains the protected controls;
opening the overview never starts work. **New task** opens the existing prepare-and-review intake; starting requires confirmation.

Search and the **Filters** disclosure support repository, phase, harness,
attention, chain, and sort order. Apply filters to search the whole registry, rather than
just the displayed page. The URL carries these choices, pagination, and theme
through task/run-history navigation, reload, and browser back. Counts explicitly
label all registered tasks, current matches, and rows on this page. Pages hold
at most 25 tasks. An emptied page stays selected and offers a first-page link.
Chains queued after an existing PR show that task as **Predecessor** until its
merge is recorded. If the task already owns a milestone in another chain, both
associations appear and either chain filter finds it; its owned position is unchanged.

## Refresh and recovery

One lifecycle-managed reader requests `/api/overview` every ten seconds while
visible. The endpoint renders a bounded window from the same status model; it
makes no per-row network requests and reads no transcripts. Both standalone and
mounted routes work. Task controls continue through the existing protected POST.
Each snapshot also refreshes filter choices from the full registry. Unsaved search
and selections stay intact; a selected value with no remaining tasks stays visible
and is labelled accordingly. An active native picker receives new choices on blur.

A read has an eight-second deadline, including response-body consumption. A
failure leaves the last good snapshot visible with its observation time. Retries
back off to 20 and 40 seconds, then pause after three failed reads. **Refresh**
restarts the bounded cycle. Fetch freshness is separate from daemon health and
each task's last meaningful activity. Workspace status remains available below
the task list, including daemon and repository guidance.

Keyed updates retain native disclosure elements. Selection or keyboard focus in
a task holds updates for explicit application. Reordering while scrolled or
expanded also offers **Apply updates** instead of moving the list underneath the
reader. Same-order updates retain the visible row's scroll position. Navigation
aborts reads; back-forward cache restoration resumes one controller. Polling
never changes saved activity timestamps or replays a control request.

## Browser proof and maintenance

`test/ui/fixture.mjs` remains the foundation's version 1 comparison fixture.
The desktop and mobile PNGs use those same six records and the fixed clock
2026-09-24 14:30 UTC. Their completed/unverified rows are intentional: the fixture records finished tasks
without qualified completion evidence. `test/ui/overview-fixture.mjs` adds isolated
synthetic attention, retry, readiness, multi-harness, long-name, and chain cases
for browser assertions; it shares the same server and fake service boundaries.

```sh
npm run lint
node --test test/tracker.test.mjs test/tracker_controls.test.mjs
node --test test/tracker-presentation.test.mjs
npm run test:ui
node test/ui/capture.mjs overview-desktop
node test/ui/capture.mjs overview-mobile
git diff --check
```

The approved captures are [desktop](ui/previews/overview-desktop.png) at 1440 ×
1000 and [mobile](ui/previews/overview-mobile.png) at 390 × 844, full-page,
device scale 1, dark theme, reduced motion, Chromium 145.0.7632.6 on macOS arm64.
Compare the [foundation baseline](ui/previews/foundation-overview-dark.png).
Captures are real served HTML, CSS and scripts, not edited composites. Tests
cover both themes, 360/390/768/1280/1440 CSS-pixel widths, landscape, 200% content
zoom, keyboard, axe WCAG AA checks, 1,000-task pagination/search bounds, slow and
failed reads, selection, focus, disclosure, scroll, and lifecycle cleanup.
Cross-platform font rasterization is not a pixel gate. The existing CI pins its
browser environment; [final qualification](ui-qualification.md) adds Firefox and
WebKit journeys and pinned Chromium visual comparisons.

Restart the tracker server after upgrading its assets. There is no state-schema
change. To roll back, revert the overview code/assets and its additive
presentation fields together; task state and saved execution evidence remain
compatible. Browser tools and fixtures stay development-only; approved captures
ship with the public guides.

## Navigation and loading

Outgoing HTTP(S) links use the shared safe-link policy, open in a new tab with
`noopener noreferrer`, and include a visible arrow and an accessible hint. This
also applies to links added by live updates. Internal navigation stays in the
current view. Native navigation delays its dismissible progress panel by 200ms; fast changes
show no transient loader. The panel never shifts the header or current content,
and slow navigation never replays an action. Saved artifacts
show a loading placeholder until their bounded metadata read settles. Empty lists
explain what is missing and offer the existing filter, setup or preparation paths.

`test/ui/usability.test.mjs` covers completed/unknown filters, chronological order,
selected-link history, new-tab safety, delayed navigation, default chain selection,
320–1440px layouts, light/dark themes, keyboard focus, axe and JavaScript-disabled
rendering. It uses synthetic state and cannot dispatch real work.
