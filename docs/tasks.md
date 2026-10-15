# Natural-language tasks

Start here when you know the outcome but do not want to hand-write a PRD. The
output can be code, a research report, documentation or content; it must belong
to a GitHub repository and have verifiable acceptance criteria. Preparation
produces the same structured contract used by written briefs.

After [setup](install.md), run inside the target checkout:

```sh
gallivant task "Explain the existing backup and restore commands in docs/operations.md. Change documentation only." \
  --harness codex --verify 'git diff --check'
```

Inspect the returned draft or answer its questions, then use its printed `Next`
action to authorize implementation. Add `--run` to the original request when you
want implementation to start automatically once the brief is ready. This is
execution authorization, including after clarification answers. It is not a
merge, deployment or release approval. To open the dashboard after dispatch,
run `gallivant start` with no PRD path.

| Selected harness | Preparation boundary |
| --- | --- |
| `claude` | Local restricted mode with tools, MCP and skills disabled |
| `codex` (0.160.0+) | Local restricted native tool/filesystem capability |
| `openai-agents` | API text-only session, no environment, tools or delegation |
| `gemini`, `opencode`, `goose` | No preparation adapter; use a written PRD for implementation |
| `codex-cloud` | No preparation adapter; new implementation dispatch is also disabled |

Use `--harness` explicitly when configuring multiple adapters. Task intake
otherwise selects the first configured harness. See
[preparation qualification](preparation.md) and [hosted setup](openai-agents.md).

`gallivant task` turns text into an isolated, reviewable PRD. Preparation uses the
selected harness's configured model and provider settings. This
can use inference even when you only prepare; it does not start implementation or
open a pull request without execution authorization.

For a new request such as “Implement CSV and JSON export, test both, and open one
pull request for review,” Gallivant preserves the original text and records exact
source spans assigning only the affirmative publication clause to the coordinator.
All remaining implementation requirements and prohibitions stay in the provider's
acceptance criteria. The generated brief's **Coordinator delivery contract** is
part of both initial approval and ongoing change detection. Its publication
obligation is fulfilled only by matching canonical repository, PR, base, head and
completion-gate evidence; a provider statement cannot fulfill it.

New ownership contracts also include a same-statement connector such as `, and`,
`and then` or `then` in the publication span, so it cannot become a dangling
implementation requirement. Connectors split across lines or containing quoted
implementation text need clarification. Previously approved version-one
contracts keep their original spans, criteria and fingerprints on retry;
new requests use version two.

This first recognizer supports one unqualified `open/create/raise/submit` review-PR
clause outside quoted text/code. It is not a general natural-language permission
parser. Conditional or negated publication clauses, owner approval prerequisites,
destination qualifiers, multiple PRs and delivery-only requests return
`TASK_DELIVERY_SCOPE` before inference. Unsupported publication actions also
require clarification; they never become impossible provider obligations.
Initial requests and later answers share the same bounded directive checks.
Local-only, no-push, task-hold or patch-only directions cannot silently fall back
to the default review-PR workflow. Preference wording such as “I don't want a PR”
or “We don't need a pull request” also requires clarification.

Implementation subjects such as a PR status badge, pull-request template,
published articles, a publish button, a command to publish docs, local storage,
commit SHA, diff viewer or branch selection
remain ordinary requirements. Technical conditions also remain implementation
scope: `If name is empty, return friend. Open a PR for review.` and the answer
`Commit the database transaction after validation.` are supported. By contrast,
`Wait for my approval. Open a PR for review.` requires clarification before work.
An implementation may consist entirely of a prohibition, such as “Do not log API
keys in error responses.” That requirement remains in the acceptance criteria.
Negative coordination preserves each action's scope: “Do not commit the database
transaction nor push changes” still forbids delivery. Combining only technical
operations, such as a database transaction and inserting items into a queue,
remains implementation scope; `neither … nor …` follows the same distinction.
Modal forms such as “nor should you push” retain the prohibition too.
Local conditions attached to publication are still refused; the parser does not
guess that a comma or semicolon ended a prohibition or approval requirement.

Keep every feature requirement and restriction, and state publication separately
when needed. Quoted literal labels/code remain implementation data, including
paired typographic single/double quotes; unmatched typographic quotes do not hide
instructions. If local-only
or patch-only output is required, do not authorize this review-PR workflow or
remove the restriction to bypass clarification.
Clarify the complete task with the owner and submit it under a new operation ID;
never delete a condition just to pass validation. Answers may refine implementation
but cannot silently replace publication ownership or add a publication prerequisite.
This applies to explicit publication clauses, the default review workflow and new
answers to older saved tasks without completion metadata. Exact previously
accepted answer retries still replay their saved receipt. There is no typed
delivery-amendment operation yet. The supported answer boundary
conservatively refuses recognized lifecycle/artifact language; it does not claim
to understand every possible paraphrase. Review the complete saved owner contract
before authorizing implementation, and clarify conflicting delivery intent instead
of treating a model's interpretation as permission.
Selecting `integrated` still grants no merge authority. Existing saved tasks,
approved criteria, false attestations and exact operation retries retain their
original semantics; this change does not repair historical results.

Preparation uses a capability on the selected harness adapter, through the same
execution service for drafting, questions and repairs. Gallivant owns deterministic
validation/readiness and explicit implementation authorization. The examples
select Claude; `--harness codex` uses Codex
0.160.0 or newer. Claude removes its tools. Codex removes external and execution
tools and uses a filesystem profile that grants no project or credential access
to any remaining tool. Only the bounded context in the prompt is available.
Model/provider defaults remain selected. `openai-agents` uses the text-only API
boundary described above and retains its explicit account/model. Gemini,
OpenCode, Goose and Codex Cloud return
`TASK_PREPARATION_BOUNDARY` until their preparation capability is implemented;
there is no automatic fallback. See [qualification](preparation.md).

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
Use an explicit selection when several adapters are configured.
Selected context consists of explicit repository files. Root `AGENTS.md`, common
build manifests, supported text lockfiles and instructions above selected files
are included automatically. Package-script inference uses `packageManager` first,
then an unambiguous `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
`yarn.lock` or `bun.lock`. It does not default to npm. Missing, unsupported or
conflicting manager evidence is exposed in `commandIssues` for clarification;
answer with an explicit `--verify` command or selected manager context. Binary
lockfiles are outside the text context contract; supply a supported manifest
setting or explicit check. Selecting a nested `package.json` also snapshots
supported text lockfiles beside it. Automatic lockfiles use the same path and
combined byte limit as other selected files, including at answer time.
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
requires Bedrock selection. Claude preparation resolves exactly one enabled
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY`
flag before carrying authentication. The string values `1`, `true`, `yes` and `on`
enable a mode, ignoring case; `0`, `false`, `no`, `off` and empty values disable it.
With a cloud mode enabled, direct `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `.credentials.json` and `.claude.json` login state are
excluded. With all modes disabled, direct authentication remains available.
Rebuilding clears prior private Claude login and cloud authentication copies,
including when mode selection fails. Native files retain their contents.
Conflicting or unsupported flag values stop with `TASK_PREPARATION_ENV` before
launch; keep the configured provider and export one unambiguous selection.
Claude settings are strict JSON. Provider selectors or authentication variables
in their `env` block also stop preparation because native settings can override
the shell selection. Export those configured values and use a dedicated
`CLAUDE_CONFIG_DIR` profile without such overrides; model and permission settings
remain in the copied file. See the
[Claude environment reference](https://code.claude.com/docs/en/env-vars) and
[settings reference](https://code.claude.com/docs/en/settings).
For Goose, `GOOSE_PROVIDER` overrides the copied native
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
Codex uses the restricted native capability described in [preparation](preparation.md).
These local environment/profile details do not describe hosted preparation:
`openai-agents` uses its selected API account and a text-only remote session,
without a host credential profile or workspace.
Gemini, OpenCode and Goose preparation return
`TASK_PREPARATION_BOUNDARY` before probes, profile copying or model launch because
their current adapters have no established preparation read/write boundary or
tool-free contract. There is no automatic harness, model or provider fallback.
Use a hand-authored PRD with the existing `ready`/`start` path until an enforced
preparation adapter is supported. Native Codex boundary qualification uses an
installed CLI against a local provider fixture; live inference and installed
ChatGPT workflow qualification remain separate checks.

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

## Choose the delivery milestone

Select the target when preparing a task, using `--completion-target integrated`
or the structured `completion: { target: 'integrated' }` field. Omission selects
`delivery_ready`. Capability discovery supplies supported targets and labels;
clients should render those choices instead of maintaining a separate list.
The target is immutable for a saved request. Changed retry input conflicts.

`delivery_ready` is fulfilled when the current pull request passes Gallivant's
existing checks, reviewer and completion gate and its owned execution is settled.
The saved execution ledger is checked even when the task registry has not caught
up; pending collection keeps the target pending. Automatic observation and fixing
then stop at that saved handoff; later review comments do not authorize more work.
An explicit existing recheck/resume control reopens the normal workflow.
`integrated` keeps the existing coordinator watching that qualified delivery until
GitHub reports it merged. Neither choice grants permission to merge, release or
deploy. While monitoring, a new head or blocking feedback uses the existing review
loop; no parallel runner is created.
Closing without merging is blocked. An early merge, stale receipt/head/base,
missing merge proof or changed checks/review is unverified, not fulfilled.
Cancellation keeps its existing authority and stops further dispatch.

Saved results include `completion.target`, `status`, `reason`, `monitoring` and
`evidence`. Delivery evidence records the exact head, base, receipt hash, check
count, reviewer verdict and completion-gate source/decision ID. Integration
records GitHub's observed head, merge commit and timestamps. It is observational
evidence, not a provider's self-report or a newly signed completion credential.
Legacy tasks retain their workflow behavior and receive no invented evidence.
A skipped completion gate cannot claim a fulfilled target.
A qualified, stopped handoff can release its artifact pin for a compatible idle
runtime update. Pending controls, live/uncollected execution, unresolved receipts,
intake or chains still block migration independently; evidence and saved intent
are preserved without rewriting the historical workflow state.

Keep implementation acceptance separate from coordinator publication. For example,
a host can prepare a greeting change with the complete behavior, native Node test,
README and scope constraints in `text`, plus `completion: { target: 'delivery_ready' }`
for the pull-request lifecycle. A chat host should organize the owner's prose and
show the complete brief and selected target for review; the owner need not learn a
special input format. Preserve explicit prohibitions such as no merge, release,
workflow edits, new dependencies or access to other repositories. The target never
overrides those constraints.

New completion-aware drafts consolidate criteria with identical requirement
coverage, preserving all immutable owner fragments and their mappings. Existing
approved drafts and false attestations are never rewritten. Only supported
affirmative publication clauses can be separated from mixed
implementation/publication text. A host must clarify unsupported or ambiguous
ownership rather than silently drop a requirement. The generated
Delivery target section explains which milestones the coordinator observes.

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
Explicit project overrides such as
`--verify 'npm test --prefix packages/app' --context packages/app/package.json`
carry every selected `package.json` and matching manager lockfile, including nested
paths. This also covers flags before the action and pnpm, Yarn and Bun owner
commands. Selecting a subproject does not infer argument-bearing commands or
replace root package-manager evidence. The same tool-family rule binds selected
Go, Cargo, Make and pytest manifests at any repository depth. It preserves the
existing Maven/.NET behavior without interpreting arbitrary shell syntax.
See the [npm prefix configuration](https://docs.npmjs.com/cli/v11/using-npm/config/).
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
an already authorized, ready intake.

An explicit resume also retries a remote preflight deadline when the saved record
proves it happened before submission. It preserves the task, requirements,
allowance and previous settled attempts. The retry reruns provider authorization
and the normal preparation boundary. A bare legacy timeout, uncertain dispatch,
policy refusal, exhausted allowance or malformed output does not grant this retry.
Those records remain blocked or reconcile their already-owned provider operation.

The portable `prepare` and `answer` operations accept optional `verifyCommands`
(up to 32 commands, each up to 500 characters). These are explicit owner
selections, passed through the same supported-command and source checks as the
CLI. Writing a command in an answer does not itself select executable authority.
Selections are part of the operation identity; changing them requires a new
operation on the current task revision. Preparation progress in delivery views
uses the saved preparation attempt until implementation owns a run.

`task validate` returns `TASK_NOT_READY` while preparation is incomplete, even if
an older question-bearing draft exists. It leaves the saved revision, accepted
answers and owned run unchanged; resume preparation with the current revision
before validating. Resume reconciles that run and retains its usage and deadline
checks without purchasing a replacement turn.

Request identities deduplicate preparation; reusing one for different inputs
conflicts. Answer operation identities deduplicate replies. Every mutation checks
the expected state revision.
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

These exports are local, trusted, in-process operations. The implemented
[task-delivery dispatcher and MCP integration](task-delivery.md) add scoped
account/repository authorization for host applications. The task module by itself
is not an authenticated public server.
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

See [the evidence index](https://github.com/uchibeke/gallivant/blob/main/docs/audit/plugin-ready/README.md) for the separate G8 live
prerequisites, unavailable attestations and bounded qualification procedure.

Direct task-service mutations acquire the namespace task-mutation owner through all asynchronous effects and release it on success or failure. They refuse artifact-pinned homes; those homes use the manifest-aware delivery adapter. CLI and delivery adapters borrow their existing live owner, checked against the same namespace, while inspect/list stay read-only.
