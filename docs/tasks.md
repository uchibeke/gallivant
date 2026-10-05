# Natural-language tasks

`gallivant task` turns text into an isolated, reviewable PRD. Preparation uses the
selected harness's configured model and provider settings. This
can use inference even when you only prepare; it does not start implementation or
open a pull request without execution authorization.

The preparation examples require configured Claude and explicitly select it.
Preparation currently accepts only Claude with all tools disabled; other adapters
return `TASK_PREPARATION_BOUNDARY` without an automatic fallback. Installed native
tools-off behavior remains unqualified, as detailed below.

```sh
gallivant task "Add CSV export for the widget table. Do not add dependencies." \
  --dir /path/to/checkout --repo owner/repo --base main --harness claude \
  --context docs/export-plan.md --request-id export-2026-10 --json
cat request.txt | gallivant task --stdin --dir /path/to/checkout --harness claude --json
```

The repository resolves from the checkout using the existing Git/GitHub helpers.
`--repo` asserts its identity; it must match that checkout. Base precedence is the
usual explicit flag, repository configuration, then default branch. Harness
selection uses the explicit flag or the first configured harness, as `new` does.
Selected context consists of explicit repository files. Root `AGENTS.md`, common
build manifests, supported text lockfiles and instructions above selected files
are included automatically. Package-script inference uses `packageManager` first,
then an unambiguous `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
`yarn.lock` or `bun.lock`. It does not default to npm. Missing, unsupported or
conflicting manager evidence is exposed in `commandIssues` for clarification;
answer with an explicit `--verify` command or selected manager context. Binary
lockfiles are outside the text context contract; supply a supported manifest
setting or explicit check. Automatic lockfiles use the same path and combined
byte limit as other selected files.
Context is bounded to 256 KiB and requests to 32 KiB; choose fewer files if needed.
The service also measures the smallest possible canonical brief using the checker's
1,500-word limit and the actual JSON quoting rules. Owner fragments must appear in
the mapping and executable criteria, with at least one story. If that minimum
already exceeds the limit, `TASK_INPUT` asks for a smaller request before repository
lookup or a preparation turn. The same check includes accumulated answers before
reading new context or changing the accepted revision or answer-operation identity;
a shorter corrected answer can reuse the refused operation identity. Raw whitespace
word counts alone are insufficient because JSON quoting escapes tabs. Recovery
settles any already-owned preparation turn and preserves usage before stopping
oversized saved state; it launches no further planning or repair turn.
An intake accepts at most 128 immutable requirement fragments across nonblank
request and answer lines, matching its mapping capacity. Oversize requests stop
before repository lookup or preparation. An answer that exceeds the remaining
capacity is rejected before context reads or state changes; its operation ID and
revision remain available for a corrected reply. Prepare a smaller intake if
the remaining material questions cannot fit. Existing owned turns are reconciled
with usage retained before oversized legacy state stops without a new turn.
The complete serialized preparation prompt is also limited to 120 KiB, including
JSON escaping, runtime instructions, saved answers, previous output and repair
feedback. This portable limit is checked before a harness probe or launch on every
new turn. Oversize input stops with an actionable failure and keeps the saved
requirements, without truncation, a launch intent or another model call. Prepare
a smaller intake with fewer or smaller documents; blocked intakes do not retry
automatically. Reopening an already launched turn reconciles that run as usual.
Preparation receives these documents in its prompt and does not inherit global
`context_paths` read grants. Its child environment admits process basics and the
selected adapter's explicit provider authentication/settings allowlist, defined
in `lib/harness.mjs`, with cloud-mode additions in `lib/task_environment.mjs`.
Unrelated tokens, database URLs, other adapters' keys and
shell startup overrides are excluded. Preparation has a private `HOME`, XDG roots
and temporary directory. The selected adapter's native auth/config files and
configured resource directories are copied into private snapshots, so parent
traversal and preparation writes
cannot reach native files through those entries. A selected entry itself must be
a regular file or directory: even an internal or broken top-level symlink is
refused before launch. Replace that entry with the intended provider file or
directory. Links inside a selected resource directory are materialized; links
outside that directory, cycles, broken links and special files stop preparation
before launch and remove partial copies. Previous
sessions and unrelated home-directory credentials are excluded. AWS authentication
requires Bedrock selection. For Goose, `GOOSE_PROVIDER` overrides the copied native
`config.yaml` selection; otherwise preparation reads `active_provider`, falling
back to legacy `GOOSE_PROVIDER`. Plain or quoted provider names retain their
selected model and configuration bytes. Complex or ambiguous YAML selectors stop
before launch with guidance to set `GOOSE_PROVIDER` explicitly to the native
provider; preparation never guesses or switches providers. Rebuilding a private
turn removes earlier AWS snapshots even when the new selection is another
provider or cannot be resolved. See the
[Goose configuration reference](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/config-files.md).
Preparation projects only `AWS_PROFILE`
(or `default`) from the shared config and credentials files, including files
selected through `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`. Other
profiles, comments, caches and unrelated files are excluded. Complete selected
file credentials also exclude overridden config credentials. Complete environment
credentials or explicit web identity omit native file credentials; an environment
region also avoids reading unused ambient configuration. Named profiles resolve
the same explicit environment identity in SDKs that prioritize profile lookup.
Private files use mode `0600`, and rebuilding removes earlier shared snapshots.
Flat static profiles and supported region/retry settings retain their values;
credential chains, SSO/cache dependencies, ambiguous sections or unsupported
settings stop before launch without automatic retry. Export scoped temporary
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` credentials and `AWS_REGION`, or select
a dedicated static profile through the AWS file settings. See the
[AWS shared-file format](https://docs.aws.amazon.com/sdkref/latest/guide/file-format.html).
Claude's explicit Vertex mode can also use
native Google credentials. Gemini with `GOOGLE_GENAI_USE_VERTEXAI=true` carries
only `gcloud/application_default_credentials.json` into its private config root.
Claude's enabled Foundry mode forwards only its configured
`ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_BASE_URL`,
`ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_AUTH_TOKEN` values, retaining
native endpoint/authentication precedence and the selected model. These values
are excluded when Foundry is off or another adapter is selected. Azure CLI caches
and unrelated Azure credentials remain excluded; supply an explicit Foundry key
or bearer token if authentication otherwise needs those native files. See the
[Claude Foundry settings](https://code.claude.com/docs/en/microsoft-foundry).
Explicit `GOOGLE_APPLICATION_CREDENTIALS`, AWS web-identity token files and
`OPENCODE_CONFIG` also point to private copies, retaining the selected contents
and authentication precedence. Refreshes and edits stay in the preparation turn.
Relative provider file and profile paths use the original invocation directory,
saved as `callerCwd`, even when `--dir` selects another checkout. Repairs, retries
and resumed answers keep that directory. Older version-1 intake records without
it use their saved checkout; a missing selected file stops before launch.
Model and provider selections are preserved. Preparation uses a separate tool
contract; implementation argv, permissions and defaults retain their behavior.

`GH_CONFIG_DIR=/dev/null` disables stored GitHub CLI credentials. The existing Git
environment disables user/system configuration; inherited Git/SSH overrides,
askpass programs, agent sockets, terminal prompts and Git transports are disabled.
Credential separation does not add an OS sandbox. Preparation currently supports
Claude with restricted mode, an empty built-in tool set, denial of every tool,
an empty strict MCP configuration and disabled skills/commands. Selected context
is already in the prompt, so planning needs no file, shell or network tools.
Codex, Gemini, OpenCode and Goose preparation return
`TASK_PREPARATION_BOUNDARY` before probes, profile copying or model launch because
their current adapters have no established preparation read/write boundary or
tool-free contract. There is no automatic harness, model or provider fallback.
Use a hand-authored PRD with the existing `ready`/`start` path until an enforced
preparation adapter is supported. Native tool-free behavior remains unqualified;
offline argv fixtures cannot prove installed-provider execution.

Attempts record their preparation boundary. Recovery stops an owned legacy
tool-enabled child and preserves its usage/logs; completed, settled and previously
rendered output without that boundary cannot authorize readiness or dispatch.
Existing implementation runs continue through their original ownership path.

Goose environment snapshots resolve `GOOSE_PROVIDER` first, then the native
current/legacy selector. Only that provider's environment authentication/settings
are admitted; Bedrock keeps the selected AWS projection. Shared `secrets.yaml`
and keyring access are excluded, including old private snapshots. Export the
selected provider's credential when it otherwise lives in shared secret storage;
missing/unsupported selectors are refused instead of forwarding every provider.
An unsupported provider environment variable is not forwarded implicitly: use
the selected harness's native auth/config profile. Profile failures stop before a
model launch and return an actionable failure; they are not validator repairs.
Permission denials also stop preparation, including when the harness exits zero.
The result and saved attempt retain the denied calls and any guardrail reasons
recorded by the adapter, alongside provider errors and the run-log path. Reopening
or recovering that failed attempt preserves the report without another planning
turn, readiness decision or implementation dispatch.

The result includes contract `version: 1`, a durable `taskId`, a state `revision`,
original input, requirements, answers, assumptions, requirement mapping, draft
path/text/hash, source hashes, readiness evidence, preparation usage, artifacts and
the next action. `stories` contains sequential `us-N` IDs, story text and the
authorized requirement IDs associated with each story. `verifyCommands` lists
candidate commands and their authorizing
source paths, while `commandIssues` explains withheld package-script inference.
`inspect` and `list` read saved state without inference or remote
polling. Implementation results also expose the existing registry's state and PR
link, so reopening an intake does not lose access to the eventual result.

```sh
gallivant task inspect task-0123456789abcdef01234567 --json
gallivant task list --json
gallivant task answer task-0123456789abcdef01234567 --revision 2 \
  --request-id format-answer --answer 'q-r-1=Use CSV only; JSON is excluded.' \
  --context docs/export-format.md --json
gallivant task validate task-0123456789abcdef01234567 --revision 4 --json
gallivant task start task-0123456789abcdef01234567 --revision 4 --run --json
```

Use the revision and question identifiers returned by your own result. Commands
never wait for a terminal question. Missing or conflicting requirements return
`needs-input`; each answer is attached to its existing task. Piped stdin must finish
within five seconds. `--answer`, `--context` and `--verify` may repeat. Context can
be supplied during preparation or while answering questions. Answer-time files
and their instructions use the same path checks and combined context size limit;
their pinned bytes reach the resumed planner and generated source snapshots.
Existing context remains pinned. Explicit reselection of changed accepted bytes
returns a conflict. Duplicate answer identities replay without rereading files;
changing their selected paths conflicts. Other CLI task operations reject
`--context`. For a stack
without discoverable test commands, answer the material question and supply the
exact repository command using `--verify 'python -m unittest'`.

`--run` on preparation persists execution authorization through questions and
answers. Once the exact generated brief and source snapshot pass readiness, the
service starts it once and brings up the normal daemon. No second confirmation is
needed. If the process exits after saving readiness but before dispatch, retrying
the same preparation request or answer identity resumes that saved authorization
through the exact approval and dispatch-ownership checks. A preparation-only
retry still returns the draft without implementation.
Preparation without `--run` returns the draft and an explicit next action.
`--no-daemon` leaves monitoring to an explicitly started `gallivant up`.

Readiness uses the existing PRD checker and readiness decision procedure. It proves
contract structure, not semantic correctness or passing implementation tests.
Review the assumptions and mapping. All nonblank request lines are immutable
requirement fragments; their exact text is attached to mapped criteria or shown as
unresolved. An explicit answer can clarify a previously questioned fragment; the
mapping records which answer resolved it. Saved question ownership determines the
clarification even when the planner omits `resolvedBy`. All applicable answers
remain quoted in accepted order, and later answers govern conflicts with earlier
ones. Earlier answer fragments retain that precedence too, so they cannot become
standalone demands for a superseded outcome. A follow-up question about an earlier
answer fragment carries its proven original question ownership forward; unrelated
requirements retain their original scope. Repairs cannot quietly omit a fragment.
Every acceptance criterion must also appear in a requirement mapping; selected
context alone cannot authorize additional implementation scope. Unmapped criteria
trigger bounded repair, and saved drafts with them cannot validate or start.
Each planner story must include a nonempty, duplicate-free list of authorized
requirement IDs. Those links appear in the generated brief and structured result.
Links organize requirements; they do not approve planner-written behavior. The
service replaces every story and criterion's prose with a deterministic wrapper
and exact, JSON-quoted owner fragments. For a validated clarification, it quotes
both the original fragment and the saved answer, with the answer governing
conflicting parts; the original also remains in the requirements mapping.
A falsely linked deployment outcome therefore never becomes
an executable criterion or story. Owner-requested deployment remains intact.
Generated rationale, assumptions, locations and exclusions are advisory and cannot
add to or override this scope. Material ambiguity still requires an owner answer;
the wrapper does not claim to resolve it or prove semantic correctness.
Unlinked stories, unknown IDs and older string-only stories trigger repair on new
turns and fail saved validation or dispatch. Inspect an older brief and prepare a
new intake to establish its story ownership; no authorization is inferred from
untrusted context. Saved validation recomputes the same owner-derived body, so an
older draft containing planner-written executable scope cannot dispatch even if
its recorded hash and readiness digest match. Existing owned implementation runs
still reconcile without a duplicate launch. No extra confirmation is added to
already authorized `--run` work.
Each question's requirement IDs must exactly match its unresolved mappings, with
no duplicate IDs. Saved ownership limits which fragments an answer can clarify.
Reopening an older unanswered question proves ownership from its saved mappings;
inconsistent claims or missing ownership for an already answered question stop
instead of granting broader clarification. Inspect the saved evidence and prepare
a new intake if that association cannot be recovered.
Quoted fragments use reversible JSON Unicode escapes for literal placeholder
tokens, so requests such as “remove the TODO” can pass readiness. The saved request
and answers keep their original text; generated prose and hand-authored briefs
still pass the same placeholder check.
An older draft while partial answers are pending has `draft.current: false`.

Preparation stays under `$GALLIVANT_HOME/tasks/<task-id>/`: private intake state,
isolated turn directories and immutable draft revisions. Runner logs and jobs use
the normal per-run layout with a separate `intake/<task-id>` identity. Generated
source paths must be selected documents. The existing `sources` gate validates
them and `start` delivers pinned bytes to the implementation checkout, including
documents that exist only in the operator tree. Symlinks, escapes, globs, control
characters and secret/agent configuration paths are refused by intake. Existing
hand-authored PRDs retain their source-manifest rules. Editing the original
source after approval does not silently change the selected snapshot.
Task source paths beginning or ending with a single or double quote are refused
before planning or answer writes, because the existing frontmatter parser cannot
preserve those boundary characters. Rename the file or select another path.
Quotes inside a path remain supported. Generated and saved source manifests use
the same task-specific guard; hand-authored source parsing is unchanged.
Task source paths with leading or trailing whitespace are also refused before
the shared parser can trim them into a different filename. Raw selections are
checked before request or answer identity replay, without rereading accepted
files. Rename the file or select a different path. Internal spaces, including
spaces inside directory names, retain their exact identity and selected bytes.
Inferred Verify commands require their pinned authorizing manifests or instruction
files in the generated `sources`. Repair may add these selected files; it cannot
silently drop the dependency. The existing start path delivers their exact bytes
to the fresh base checkout, including scripts present only in an operator's dirty
or feature checkout. Commands explicitly supplied by the owner without inferred
repository evidence remain explicit choices; a duplicate explicit command cannot
bypass a known source dependency. Commands with extra arguments also carry their
selected stack manifest. Saved drafts are checked against the same rule.
Matching text lockfiles also remain pinned and carried, so a fresh base receives
the evidence used to select its manager. Automatically inferred instruction
commands must name test, lint, check or typecheck actions; publishing, deployment,
release targets, paid/live checks and composed shell commands are not candidates.
Instruction inference accepts canonical invocations without extra arguments:
package-manager test/check scripts, named Make checks, `go test ./...`, `cargo test`,
`python -m pytest` / `pytest`, and `git diff --check`. Runner flags, plugin loading,
project overrides, output paths and even benign extra flags require explicit
owner selection with `--verify`, including on an answer. Their supporting
manifests still need to be selected and carried. Legacy cached candidates are
rechecked before readiness and dispatch under the same restriction.
Maven and .NET commands are not inferred from instructions because their project
manifests do not yet have automatic snapshot support. Supply the repository's
check with `--verify 'mvn test'` or `--verify 'dotnet test'` and explicitly select
its supporting manifests with `--context`; those owner choices remain available
during preparation and answers. Explicit Maven commands must carry every selected
`pom.xml`, including parent and module POMs. Explicit `dotnet test` commands must
carry selected `.sln`, `.slnx`, `.csproj`, `.fsproj` and `.vbproj` files. The same
provenance rule applies to answers, repairs and saved-draft validation before
start, so a fresh base receives the selected manifest bytes. Checks without
selected project files remain explicit owner choices. See the
[Maven POM documentation](https://maven.apache.org/guides/introduction/introduction-to-the-pom.html)
and [.NET test command reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-vstest).
Known manifest scripts and established manager selection take precedence over
unrelated instruction snippets. The service records explicit owner commands
separately from inferred candidates. Reopening an older record rebuilds inference
and rechecks saved drafts; a cached command alone does not prove owner selection.
If an older explicit choice cannot be recovered, prepare a new intake with it.

At most three validator repairs occur, across the entire intake, and at most 16
preparation turns including clarification turns. They share the configured
preparation budget and cumulative runtime allowance. Reported costs and usage are
recorded per turn; unavailable costs stay `null`. The spend cap is enforced by
harnesses that support it, while others have turn/runtime bounds and cannot promise
a hard dollar cap. A provider error, tool denial, exhausted allowance, unresolved
dispatch or readiness denial stops visibly. A blocked intake is not automatically
retried or assigned to a different provider.
Recovered completion must also fit its persisted deadline. A known completion
before the deadline remains usable even if reopened later; a completion after it
is refused with its usage and log evidence retained. If the coordinator missed
the exit and no end time exists, runner settlement time is a conservative bound.
An over-budget saved-output replay cannot become a pass or another repair turn.

Use `task resume <id> --revision <n>` to reconcile interrupted preparation or finish
an already authorized, ready intake. Request identities deduplicate preparation;
reusing one for different inputs conflicts. Answer operation identities deduplicate
replies. Every mutation checks the expected state revision.
Answer operation IDs, including `__proto__`, are persisted as own dictionary keys
and replay after restart; an unknown question ID is refused without dropping it
from CLI input or changing the accepted state.
Missing launch acknowledgements reconcile the recorded job; uncertain
implementation acceptance retains its start claim/intent and requires inspection
rather than another launch.
For a known preflight failure before cloning (for example missing GitHub credentials,
a stale worktree refused before the clone command, a parent-path conflict, or clone
environment resolution failure),
fix its cause and explicitly call `task start` with the saved current revision.
The shared start claim and intake dispatch intent are released only when the
creator confirms that no clone executor was invoked. Stale operator files are
preserved for inspection; the refusal never deletes them. Existing run authorization,
requirements and approved snapshots are retained. Once cloning is attempted, the shared
start claim records the planned worktree, branch and base and survives clone,
source-delivery or later pre-spawn failures. `dispatchRecovery` exposes that clone
in structured results and CLI output points to it. Inspect the retained clone,
snapshots, claim and any runner job before recovery; ordinary retry never clears
that ownership, deletes the checkout or attempts another clone. A possible spawn
is also never cleared this way. Hand-authored starts and chains share the same
ownership boundary.
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
  harness: 'claude', context: ['docs/export-plan.md'],
  requestId: 'export-2026-10', run: false,
});
if (result.status === 'needs-input') {
  result = await tasks.answer({
    taskId: result.taskId, expectedRevision: result.revision,
    operationId: 'format-answer',
    answers: { [result.questions[0].id]: 'Use CSV only.' },
    context: ['docs/export-format.md'],
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
