# Task workspace

Open a task from Overview or keep an existing `/run?id=…&run=…` bookmark.
The task opens on its phase, recorded outcome, responsible actor and next
action. The summary shows meaningful activity age, task rounds, plan membership
and saved prerequisites. Review approved brief and carried-source changes in
place. Approved graph tasks keep their pinned inputs when continued.

Select **View PRD** beside the task summary. The viewer opens the saved brief
and lists the carried sources under **File provenance**. For example, the
synthetic task `acme/atlas/search-index` can have a saved
`docs/prds/search-index.md` alongside its carried `docs/review.json`. The
origin and digest identify the saved copy even after the checkout moves or
changes. Older records may show an unrecorded digest or a missing snapshot with
recovery steps. **Source** exposes the original UTF-8 text, and **Copy link**
preserves the selected file and view. In intake, **View prepared brief** opens
the saved draft revision in the same viewer.

Delivery evidence shows the saved task head and review policy. CI includes up to
eight canonical job observations with failures first. Reviewer activity shows
up to eight findings and the recorded reviewer pieces. Each evidence card
offers its saved source, time and head. Old-head observations are marked stale.
Missing checks, an explicit zero-check policy, a skipped or denied acceptance
gate, delivery readiness and integration each retain their own status. PR
links open the host evidence in a new tab.

Task activity shows the original incident, review, recovery, acceptance and
delivery observations when recorded. Recovery shows the pinned profile and
hold, active incident and attempt count, next retry and any pinned repair base.
Open **Task route and limits** for the approved graph route or recorded task
route, continuation, cancellation and budget qualification.

Attempts lists the twelve most recent runs and links to the existing run history.
Explicitly selected attempts keep their own duration, session, output and result
through refresh, reload, applied control requests and browser back. A newer run
is offered as a link. Task actions still apply to the current logical task.
The execution disclosure shows provider/model, session, timing, recorded cost
and token counts for that attempt. Missing usage stays unknown.
Artifacts load on demand from the existing saved-result route, with twenty visible
paths from its bounded projection. Coordinator Verify results include the
candidate head and completion status when recorded. Paths display as text.

Open **Activity · Agent log** to request diagnostics. Closing it pauses the
stream and retains the displayed rows. **Search loaded output** highlights
matching rows. **Next match** moves within that window. **Load earlier lines**
uses the existing history cursor.
The initial tail has at most 400 events. The display retains at most 2,000 live
rows plus 2,000 explicitly loaded history rows, with truncation and gap notices.
Scrolling away pauses following; Follow live output explicitly returns to the
tail. Selected text, focus and drafts survive incoming observations. A full
paused window buffers at most 400 events; overflow remains recoverable through
history rather than silently growing the DOM. Cached-page navigation retains
that paused buffer, including final output from an attempt that has ended;
Follow live output reveals it after returning.

Task snapshots refresh every ten seconds while visible. After repeated errors,
use **Refresh evidence** to reconnect. A failed read keeps the last snapshot
and gates actions that need current evidence. Loss of read scope hides task
details. Source timestamps stay tied to recorded observations. Expanded
sections, selected attempts and draft edits survive refreshes, and navigation
closes streams and pending reads.

## Qualification and captures

`test/ui/factory-task-workspace.test.mjs` serves synthetic task, plan and System
state through the real HTTP handlers at root and `/gallivant` mounts. It verifies
current and stale evidence, changed briefs, saved controls, permission loss,
capacity waits, responsive layout, 200% zoom, keyboard operation and reduced
motion. The workspace and controls suites cover bounded output and request
reconciliation. The fixture exercises real browser rendering with local state.

Set `FACTORY_TASK_CAPTURES` to a temporary directory to render synthetic
Overview, task and System captures during the suite.

```sh
capture_dir="$(mktemp -d)"
FACTORY_TASK_CAPTURES="$capture_dir" node --test --test-concurrency=1 test/ui/factory-task-workspace.test.mjs
```

Revert the console code and assets to roll back. Saved CI, acceptance and
incident observations are additive.
