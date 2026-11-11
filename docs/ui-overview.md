# Attention-first overview

The overview uses the shared task presentation model. Operator decisions and
repairs appear first, followed by qualified handoff, progressing work, automatic
or external waits, and recorded outcomes. Unknown evidence stays explicitly
unknown. A finished process or a legacy done flag cannot qualify delivery.
An operator stop remains in **Needs attention** when its owned run is missing or
unresolved. The ownership phase still shows reconciliation, and writer controls
remain unavailable until ownership is settled. Automatic retry waits stay separate.

Each compact record shows the repository, task, phase, harness, meaningful
activity age, delivery/check/review evidence, round usage, and recorded chain
position. Expand **Context & next step** for the explanation, responsible actor,
approved base and delivery target, activity and observation times, attempt
information, and task/PR links. **Technical reason & evidence** exposes the
saved reason and provenance. The task workspace retains the protected controls;
opening the overview never starts work. New task remains unavailable pending
intake implementation.

Search and the **Filters** disclosure support repository, phase, harness,
attention, and chain. Apply filters to search the whole registry, rather than
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
2026-09-24 14:30 UTC. Their unknown/unverified rows are intentional: the fixture
has no qualified completion evidence. `test/ui/overview-fixture.mjs` adds isolated
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
browser on Ubuntu; Firefox and WebKit qualification remains the final milestone.

Restart the tracker server after upgrading its assets. There is no state-schema
change. To roll back, revert the overview code/assets and its additive
presentation fields together; task state and saved execution evidence remain
compatible. Browser tools, fixtures, and captures remain excluded from the
published runtime package.
