---
status: ready
harness: codex
---

# Show task briefs and plan files in one viewer

## Problem

The Task page shows the saved brief path, fingerprint and change status without a way to read its contents. A prepared intake uses a separate raw text disclosure. Plan reviews need the same ability to inspect the manifest, referenced briefs and carried source files. Give the operator one read-only viewer that uses Gallivant's own saved evidence and works wherever the tracker is mounted.

## User stories

- As an operator opening a task, I want to read its full PRD beside its status and actions, so that I can judge progress against the actual requirements.
- As a plan reviewer, I want to open the manifest and the relevant briefs and sources in the same viewer, so that I know what each approval covers.
- As a user of Command Center or the standalone dashboard, I want the same keyboard, theme and link behavior, so that file review feels consistent.

## Acceptance criteria

- Given a registered task with a saved brief, when I select **View PRD** on its Task page, then the viewer opens the exact approved snapshot and lists its carried sources with their provenance. A moved or edited checkout never silently replaces the approved bytes. Legacy or missing snapshots show the known provenance and a recovery message.
- Given a generated intake draft, a queued plan leaf or an authorized plan review, when I open its file, then the same viewer reads the right saved draft, approved plan input or reviewed preview. Show the meaningful revision and origin. For a legacy chain that saved a digest before any snapshot, serve its approved checkout copy only while the bytes match. A changed or missing file shows the existing change evidence.
- Given authorized Markdown, YAML, JSON or another supported text file, when I switch between the readable view and source, then I can read, copy and link to the original text. Markdown headings, lists, tables and code stay readable, and the source retains exact bytes for revision comparison. Binary, empty, oversized and unavailable files have explicit states.
- Given a file contains untrusted content or a request names a file from another scope, when it is opened, then the service resolves an opaque artifact reference only within the entitled task, plan or review. Unsafe links, raw HTML and remote-media loads stay inert. Traversal, replaced paths, credentials and unauthorized file reads are rejected before content is returned. Responses avoid shared caching and absolute machine paths.
- Given I open a file from Task, intake or Plans and use refresh, browser history or a copied viewer link, when I return, then the task or plan selection, file and view restore correctly in both the standalone and Command Center mounts. The shareable selector carries identity and revision without any authority or secret.
- Given keyboard and touch navigation, both themes and 360–1440 px widths including 200% zoom, when I review long files, then the document fits without page-level overflow, has visible focus, supports heading navigation and keeps the current action reachable. Shared loading, empty and recoverable error states preserve layout and discard stale responses. Permission loss clears protected content.
- Given the implementation is packaged, when the current tracker and a Command Center-compatible mount serve the same saved inputs, then both use one renderer and one revision-aware read service. Existing task actions, plan navigation and Command Center's own file views retain their behavior.

## Implementation boundaries

Use a reusable Gallivant viewer component fed by a bounded read-only artifact service. Reuse saved PRD and carried source readers, plan blobs and intake draft types. Keep file resolution and permission checks on the server. Expose one interface that the later approval page can use with a reviewed artifact reference. Keep the renderer separate from review and dispatch mutations.

Command Center mounts Gallivant's tracker through `lib/linked_apps.mjs`. Its `public/file_viewer.js` selects a renderer by extension, and `public/app.js` uses `public/md.js` for headings, sections and file navigation. Its native read endpoint accepts a path in the selected workspace and its default Markdown path can load media. Reuse the pure presentation pieces where they can ship with a strict text and link policy. Prefer the same useful preview and source patterns if extraction would pull in Command Center state, media or editing. Gallivant owns approved file resolution and ships its viewer in the package. The mounted tracker then shares that implementation directly without a sibling checkout dependency.

Place **View PRD** near the task summary. Keep approval, Resume, Recheck and Message agent distinct. Reuse the tracker sheet or page shell, tokens, safe link handling, action feedback and lifecycle. Update the task workspace, plan workspace and embedding docs with a synthetic example. The local dispatch and viewer briefs are prerequisites for the linked approval brief.

## Verify

- `node --test test/artifact-viewer.test.mjs test/tracker.test.mjs`
- `node --test --test-concurrency=1 test/ui/artifact-viewer.test.mjs test/ui/factory-task-workspace.test.mjs`
- `npm run test:install`
- `npm run lint`
- `git diff --check`

## Where to look

- `lib/tracker/workspace.mjs`, `lib/tracker/intake.mjs`, `lib/tracker/chains.mjs`, `lib/tracker/factory_access.mjs`, `lib/commands/serve.mjs`
- `lib/context.mjs`, `lib/state.mjs`, `lib/repository_files.mjs`, `templates/tracker/lifecycle.js`, `test/ui/`
- In Command Center, see `public/file_viewer.js`, `public/md.js`, the `openFile` flow in `public/app.js` and `lib/linked_apps.mjs`. The reuse findings above are sufficient when only the Gallivant checkout is available.

## Out of scope

- File editing, arbitrary filesystem browsing, native file launch and binary or office document preview.
- A second tracker shell or a dependency on Command Center for standalone operation.
- Changes to what qualifies a brief, a plan or a delivery.
