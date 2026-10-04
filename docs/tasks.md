# Natural-language tasks

`gallivant task` turns text into an isolated, reviewable PRD. It uses the configured
harness, with its existing model and permission settings, for preparation. This
can use inference even when you only prepare; it does not start implementation or
open a pull request without execution authorization.

```sh
gallivant task "Add CSV export for the widget table. Do not add dependencies." \
  --dir /path/to/checkout --repo owner/repo --base main --harness codex \
  --context docs/export-plan.md --request-id export-2026-10 --json
cat request.txt | gallivant task --stdin --dir /path/to/checkout --json
```

The repository resolves from the checkout using the existing Git/GitHub helpers.
`--repo` asserts its identity; it must match that checkout. Base precedence is the
usual explicit flag, repository configuration, then default branch. Harness
selection uses the explicit flag or the first configured harness, as `new` does.
Selected context consists of explicit repository files. Root `AGENTS.md`, common
build manifests and instructions above selected files are included automatically.
Context is bounded to 256 KiB and requests to 32 KiB; choose fewer files if needed.

The result includes contract `version: 1`, a durable `taskId`, a state `revision`,
original input, requirements, answers, assumptions, requirement mapping, draft
path/text/hash, source hashes, readiness evidence, preparation usage, artifacts and
the next action. `inspect` and `list` read saved state without inference or remote
polling. Implementation results also expose the existing registry's state and PR
link, so reopening an intake does not lose access to the eventual result.

```sh
gallivant task inspect task-0123456789abcdef01234567 --json
gallivant task list --json
gallivant task answer task-0123456789abcdef01234567 --revision 2 \
  --request-id format-answer --answer 'q-r-1=Use CSV only; JSON is excluded.' --json
gallivant task validate task-0123456789abcdef01234567 --revision 4 --json
gallivant task start task-0123456789abcdef01234567 --revision 4 --run --json
```

Use the revision and question identifiers returned by your own result. Commands
never wait for a terminal question. Missing or conflicting requirements return
`needs-input`; each answer is attached to its existing task. Piped stdin must finish
within five seconds. `--answer`, `--context` and `--verify` may repeat. For a stack
without discoverable test commands, answer the material question and supply the
exact repository command using `--verify 'python -m unittest'`.

`--run` on preparation persists execution authorization through questions and
answers. Once the exact generated brief and source snapshot pass readiness, the
service starts it once and brings up the normal daemon. No second confirmation is
needed. Preparation without `--run` returns the draft and an explicit next action.
`--no-daemon` leaves monitoring to an explicitly started `gallivant up`.

Readiness uses the existing PRD checker and readiness decision procedure. It proves
contract structure, not semantic correctness or passing implementation tests.
Review the assumptions and mapping. All nonblank request lines are immutable
requirement fragments; their exact text is attached to mapped criteria or shown as
unresolved. An explicit answer can clarify a previously questioned fragment; the
mapping records which answer resolved it. Repairs cannot quietly omit a fragment.
An older draft while partial answers are pending has `draft.current: false`.

Preparation stays under `$GALLIVANT_HOME/tasks/<task-id>/`: private intake state,
isolated turn directories and immutable draft revisions. Runner logs and jobs use
the normal per-run layout with a separate `intake/<task-id>` identity. Generated
source paths must be selected documents. The existing `sources` gate validates
them and `start` delivers pinned bytes to the implementation checkout, including
documents that exist only in the operator tree. Symlinks, escapes, globs, control
characters and secret/agent configuration paths are refused. Editing the original
source after approval does not silently change the selected snapshot.

At most three validator repairs occur, across the entire intake, and at most 16
preparation turns including clarification turns. They share the configured
preparation budget and cumulative runtime allowance. Reported costs and usage are
recorded per turn; unavailable costs stay `null`. The spend cap is enforced by
harnesses that support it, while others have turn/runtime bounds and cannot promise
a hard dollar cap. A provider error, tool denial, exhausted allowance, unresolved
dispatch or readiness denial stops visibly. A blocked intake is not automatically
retried or assigned to a different provider.

Use `task resume <id> --revision <n>` to reconcile interrupted preparation or finish
an already authorized, ready intake. Request identities deduplicate preparation;
reusing one for different inputs conflicts. Answer operation identities deduplicate
replies. Every mutation checks the expected state revision. Missing launch
acknowledgements reconcile the recorded job; uncertain implementation acceptance
retains its start claim/intent and requires inspection rather than another launch.
For a known preflight failure before spawn (for example missing GitHub credentials),
fix its cause and explicitly call `task start` with the saved current revision.
Existing run authorization is retained; uncertainty after an attempted spawn is
never cleared this way.
After implementation starts, use the existing `status`, `why`, tracker controls and
`resume --resnapshot` flow for accepted contract changes. The daemon stops at its
usual human-review and configured limit boundaries; it never merges automatically.

## Structured clients

These exports are local, trusted, in-process operations. A future transport must
bind its own account/repository authorization; this module is not a public server.
Importing it reads no user configuration and starts no daemon or network work.
Creating the usual context is an explicit caller action.

```js
import { createTaskService, TASK_VERSION } from 'gallivant/tasks';
import { makeContext } from 'gallivant/context';

const tasks = createTaskService(makeContext());
let result = await tasks.prepare({
  text: 'Export widgets to CSV. Do not add dependencies.',
  dir: '/path/to/checkout', repo: 'owner/repo', base: 'main',
  harness: 'codex', context: ['docs/export-plan.md'],
  requestId: 'export-2026-10', run: false,
});
if (result.status === 'needs-input') {
  result = await tasks.answer({
    taskId: result.taskId, expectedRevision: result.revision,
    operationId: 'format-answer',
    answers: { [result.questions[0].id]: 'Use CSV only.' },
  });
}
if (result.status === 'ready') {
  result = await tasks.validate({ taskId: result.taskId, expectedRevision: result.revision });
  result = await tasks.start({ taskId: result.taskId, expectedRevision: result.revision, run: true });
}
console.log(TASK_VERSION, tasks.inspect({ taskId: result.taskId }));
```

`prepare`, `answer`, `resume`, `validate` and `start` return promises. `inspect` and
`list` are synchronous. Failures carry `version`, `code` and `message`; CLI `--json`
renders `{version: 1, error: {code, message}}`. A `TASK_CONFLICT` requires inspecting
the current revision, not overwriting it. Persist `taskId` and operation identities
when a caller loses a response.

## Validation and live evidence

```sh
npm test
npm run lint
npm run test:task-intake
git diff --check
```

These commands are deterministic and do not call models. The focused suite covers
clear/ambiguous/conflicting input, hostile context, repair preservation, real
readiness denials, stale revisions, duplicate/uncertain dispatch, source delivery,
runner usage, stdin bounds and clean installed-package imports/help.

See [the evidence index](audit/plugin-ready/README.md) for the separate G8 live
prerequisites, unavailable attestations and bounded qualification procedure.
