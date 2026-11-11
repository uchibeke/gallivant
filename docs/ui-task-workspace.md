# Task workspace

Open a task from Overview, or keep an existing `/run?id=…&run=…` bookmark.
The summary identifies the logical task separately from the selected attempt:
repository, approved base, delivery target, evidenced phase, next action, activity
age, task rounds and chain position. Task facts and provenance expand in place.
Missing observations remain unknown; worker exit is not delivery acceptance.

Delivery evidence separates current-head CI, independent review, external review,
acceptance receipt, delivery readiness and owner publication. Expand Provenance
for each source, observation time and head. Old-head observations stay stale;
zero configured checks differ from checks not observed, and a skipped receipt
never displays as accepted. PR links open the existing delivery owner.
Reviewer findings are bounded to eight summaries, separate from author output
and operator messages. Raw reviewer evidence is not loaded by the workspace.

Attempts lists the twelve most recent runs and links to the existing run history.
Explicitly selected attempts keep their own duration, session, output and result
through refresh, reload, applied control requests and browser back. A newer run
is offered as a link. Task actions still apply to the current logical task.
The execution disclosure shows recorded provider/model, session, cost, token
counts and configured limitations; missing numbers are unknown, not zero.
Artifacts load on demand from the existing saved-result route, with twenty visible
paths from its bounded projection. Paths are text, not filesystem access links.

Activity is optional. Search loaded output highlights matching rows; Next match
moves within that window. Load earlier lines uses the existing history cursor.
The initial tail has at most 400 events. The display retains at most 2,000 live
rows plus 2,000 explicitly loaded history rows, with truncation and gap notices.
Scrolling away pauses following; Follow live output explicitly returns to the
tail. Selected text, focus and drafts survive incoming observations. A full
paused window buffers at most 400 events; overflow remains recoverable through
history rather than silently growing the DOM. Cached-page navigation retains
that paused buffer, including final output from an attempt that has ended;
Follow live output reveals it after returning.

Task snapshots refresh every ten seconds while visible, backing off to at most
sixty seconds after errors. A read failure retains the last good snapshot and
explains how to retry. Each evidence source retains its own timestamp; a current
local snapshot does not prove provider connectivity. Artifact and output failures
are reported separately and do not classify the task as failed or complete.
Navigation disposes requests and streams; cached-page restoration resumes them.

## Qualification and captures

`npm run test:ui` serves real pages through the shared synthetic fixture, at both
root and `/gallivant` mounts. The workspace scenarios cover historical navigation,
read failures, hostile text, bounded indexed 10,000-event history, text selection,
keyboard disclosure, both themes and 360/390/768/1280/1440 CSS-pixel widths.
The shared browser suite covers landscape, 200% zoom, accessibility, lifecycle,
and protected controls. `npm run test:install` checks packed-runtime assets. No live model or provider is called.

The approved PNGs use `test/ui/workspace-fixture.mjs`, a fixed clock, dark theme,
Chromium and device scale 1. Desktop is 1440 × 1000 and mobile is 390 × 844;
full-page captures show the actual rendered product:

```sh
node test/ui/capture.mjs task-workspace-desktop
node test/ui/capture.mjs task-workspace-mobile
```

Only `docs/ui/previews/task-workspace-desktop.png` and
`docs/ui/previews/task-workspace-mobile.png` are published for this milestone.
Other diagnostic captures belong in temporary storage. Revert the workspace
code/assets to roll back; there is no state migration or changed control effect.
