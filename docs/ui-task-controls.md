# Task messaging and recovery

Task actions always target the current logical task, including when an older
attempt is selected. Message agent queues a correction for the same session
after current work settles. Interrupt is off by default; when supported, its
explicit option stops current work, preserves unfinished files and continues
with the correction. A continuation consumes the existing agent allowance.

Resume agent continues authorized work after the recorded prerequisite is
repaired. Recheck PR refreshes check and review observations; it does not resume
an agent or rerun CI. Both retain the approved brief, gates and round counts.
Changed sources require the existing explicit approval flow. Closed or merged
work requires a follow-up brief. Unavailable capabilities and unresolved
execution ownership remain visible beside the controls.

Stop this task contains Cancel task. Confirmation names the logical task and
explains preserved files and remote uncertainty. An applied cancellation can
mean only that future dispatch stopped: remote work may continue until the
provider confirms cancellation. The UI keeps observing that distinction.

Requests show queued, applying, applied, failed or uncertain status with saved
request, application and finish timestamps where available. Applied means the
coordinator applied the request, not that a model acknowledged the message or
the task completed. Failed requests retain the reason and message for editing.
Check request status reads saved state without starting work.

Drafts use browser local storage, scoped to the server instance and task. They
retain text, selection and reading position across reloads and navigation.
Storage holds at most twenty drafts and twenty unresolved request identities;
ordinary drafts expire after seven days and older drafts make room first.
Discard draft clears only the draft.
Control tokens are not part of the storage record. The shared credential
detector keeps drafts with recognized credential patterns only on the current
page and asks for their removal before saving or sending. If storage
is disabled or all entries hold unresolved requests, sending is refused until
storage is available or those requests are reconciled. Open a task with a saved
request and use Check request status to reconcile it, including after its PR
closes or merges. Closed tasks expose read-only request status without a composer
or task actions. Terminal results release the matching local identity; if a
closed task's bounded history no longer includes it, the UI retires that identity
while explicitly leaving its outcome unknown. Failed reads retain the identity.

Tabs share immutable retry identities separately from draft checkpoints. Web
Locks serialize claims and settlement across tabs; a competing submission reads
the existing identity before any POST. Storage notifications and return-to-page
checks synchronize the visible controls. Poll, blur and page-exit saves cannot
remove identities or overwrite a newer draft from another tab. Browsers without
Web Locks support show a remedy and refuse submissions. Existing embedded
identities migrate on the first locked update; no server task state changes.

A delivery timeout preserves the original immutable input and request ID.
Check request status reconciles that ID against the current request and bounded
service history. Retry same request becomes available only after a successful
read establishes that the request is absent and the task's latest request has
not changed. It reads again before replaying the same identity. Unresolved
identities never expire or get evicted to make room for drafts. If another
request replaced the saved baseline and the identity cannot be found, inspect
the current execution; the UI refuses to create another request from that
uncertain input. A known failed request can be edited and explicitly submitted
as a new request.

## Maintenance and verification

`/api/run/control` remains the protected adapter to `requestControl`. POST adds
only the existing bounded `requestId`; GET optionally looks up that identity
within the requested task. Origin, peer, Host, token, JSON, field/action allowlist
and mutation exclusion checks remain in force. The coordinator owns execution,
approval and cancellation; browser reads never dispatch work.

`npm run test:ui` runs actual served pages and protected handlers using disposable
synthetic state. `test/ui/controls.test.mjs` covers keyboard and mobile controls,
both mounts and themes, accessibility, draft isolation, failed submissions,
lost-response reconciliation, retry identities and cancellation acknowledgement.
Service tests cover same-session continuation, changed briefs and closed PRs.

The approved captures show the rendered action area after a synthetic failed
correction, with its retained draft and changed-brief gate. They use the shared
fixture and `test/ui/controls-fixture.mjs`, Chromium, fixed time, dark theme and
device scale 1, at desktop 1440 × 1000 and mobile 390 × 844 viewports:

```sh
node test/ui/capture.mjs task-controls-desktop
node test/ui/capture.mjs task-controls-mobile
```

Published images are [desktop](ui/previews/task-controls-desktop.png) and
[mobile](ui/previews/task-controls-mobile.png). Diagnostics stay in temporary
storage. Revert the control UI and additive adapter changes to roll back; there
is no task-state migration or new execution endpoint.
