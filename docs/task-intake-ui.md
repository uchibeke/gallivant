# Guided task preparation

Choose **New task** from the overview. Select a configured repository and an
execution provider, choose a supported preparation route, then describe the
outcome and verification. The page explains the configured allowance and the
possible inference charge before **Prepare requirements**. Loading or refreshing
the page never checks a live provider or starts work.

The repository must have a source checkout in an existing registered task and
remain in `repos`. A missing checkout is shown with a CLI setup remedy. The
browser cannot select filesystem paths, configure credentials, change model
settings or widen runtime permissions. Preparation revalidates the checkout's
repository identity through the normal task service. If a repository has not yet
been registered, use the existing CLI task workflow first.

Answers are saved using the service's question IDs, including partial batches and
explicit additional verification commands. Saving answers may continue
paid preparation but never approves implementation. Review requirements,
acceptance criteria, verification, delivery destination, assumptions and the exact
brief. Verification lists the checks selected in that saved brief. Coding,
documentation and research all use the existing pull-request
profile and its verification and ownership gates. Selecting completion after
integration waits for a human merge; it does not grant merge authority.

**Review Start** opens a separate confirmation of the displayed revision.
**Cancel start** returns to review without changing the task. **Start approved
revision** invokes the existing start service and opens its registered workspace.
Preparation has already run readiness; Start checks the saved approval and
delivery contract rather than repeating paid preparation. Cancel an existing
implementation through its task workspace controls.

## Recovery and storage

Drafts and immutable pending requests are scoped to this runtime and task in
browser storage. Web Locks coordinate submissions across tabs. Tokens and known
credential patterns are not persisted. Storage failure disables new requests;
keep the draft and restore storage before continuing.

An uncertain response never triggers an automatic POST. Use **Refresh saved
status** first. If the operation is still unresolved at the same revision,
**Retry same request** reuses its original input and identity. A changed revision
must be reviewed again. A saved implementation offers **Open task workspace**;
never create another preparation to recover it. A failed read retains the last
review and answer draft, but disables Start until a successful refresh.

Repository removal, unsupported preparation, failed provider access and readiness
denials remain visible. Repair the configured provider through the CLI; choosing
the bounded model route is an explicit owner choice, never a fallback.

## Maintainer boundaries

`GET /task/new`, `GET /api/task/intake` and protected
`POST /api/task/intake/{prepare,answer,resume,validate,start}` work at the root and
under the existing mount prefix. POSTs reuse the loopback/Host, exact Origin,
per-runtime token, JSON and 32 KiB protections in `serve.mjs`. Schemas derive from
the portable delivery contract; local allowances stay operator configured and
there are no browser context paths. New preparations require an explicit route
and typed delivery profile.

`createTaskService` owns all task data, question mappings, approval, readiness and
dispatch. Prepare and answer reuse its persisted request identities. Revision-only
actions name their action, task and expected revision with
`intakeRevisionOperation`; reusing that identity for another revision is rejected.
Stale Start retries read the existing outcome rather than authorizing a new
contract. No additional task store or ownership mapping is introduced.

`test/ui/intake-fixture.mjs` supplies synthetic inference, host access, runner and
daemon boundaries around the actual services. `npm run test:ui` exercises protected
routes, uncertainty, failure, keyboard, accessibility and responsive layouts.
The approved `task-intake-desktop.png` and `task-intake-mobile.png` captures are
real Chromium renders of those synthetic fixtures, not live-provider evidence.

The runtime package includes the new modules and shared assets through its
existing `lib`, `templates` and `docs/*.md` entries. Roll back with the prior
package; saved task records retain their existing version and CLI recovery paths.
