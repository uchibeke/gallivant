# Validate supported harnesses with real coding runs

Audit: 2026-10-01 UTC (2026-09-30 in America/Toronto). Scope: [PRD](../prds/harness-live-validation.md).

**No newly tested combination is live-verified.** Thirteen start attempts cover eleven provider/model combinations: five historical starts, six additional starts, and two targeted retries after a demonstrated directory defect. No resume turn was eligible. The Console Alibaba retry authored files, passed its tests, committed and pushed, but failed the external behavior check because the original prompt was ambiguous. The PRD's complete coding and continuation criteria remain unmet. No native approval denial was retried and no permission setting was relaxed.

## Support matrix

An adapter is a harness integration, not a provider subscription. A working CLI, catalogue entry, login, or supported-tool listing does not establish model access, available credits, permission for unattended use, or a completed Gallivant lifecycle.

| Harness | Installed version | Provider / model | Permission boundary | Available budget enforcement | Evidence and demonstrated support |
|---|---|---|---|---|---|
| Claude Code | Configured binary 2.1.263; PATH binary 2.1.177; adapter minimum 2.1.263 | Existing production provider/model not recorded; current model setting unset | Gallivant settings sandbox, auto permission mode, no interactive prompts, existing APort hooks | Native USD cap plus Gallivant wall clock | Existing production evidence reported in the PRD and [PR #3](https://github.com/uchibeke/gallivant/pull/3); no new calls. **Configured binary passes preflight.** The original audit tested PATH instead; see correction below. |
| Codex | 0.158.0 | Current config: OpenAI default provider / gpt-6-astra; production run's exact model unknown | workspace-write, on-request escalation through auto_review, network enabled; existing hooks retained | Wall clock; no adapter USD cap | Existing production evidence in PRD/[PR #3](https://github.com/uchibeke/gallivant/pull/3), plus its earlier disposable Git start/resume probe. No calls repeated here; current configured model is not attributed to historical runs. |
| Gemini CLI | 0.59.0 | Gemini API-key auth / `auto` resolved to gemini-3.5-flash | Existing native workspace/tool policy; trust flag only, no yolo or new grants | 180 seconds/turn, 30 minutes/suite; no adapter USD cap | **Live adapter attempt blocked**, start: workspace refusals; resume blocked. Earlier event/session fixtures are not coding proof. |
| OpenCode, existing default | 1.18.31 | OpenCode Go / deepseek-v4-flash | Existing native permissions, no `--auto`; external-directory request auto-rejected on closed stdin; no Gallivant OS sandbox | Same time bounds; no adapter USD cap; cost reported per step | **Live adapter attempt blocked**, start: permission refusal on sibling remote; resume blocked. |
| OpenCode, explicit Go case | 1.18.31 | OpenCode Go / qwen3.8-max | Same existing native permissions; no new grants | Same time bounds; per-step cost | **Live adapter attempt blocked**, start: external-directory permission refusals; resume blocked. Export confirms `opencode-go`, not Zen's similarly named model. |
| Goose, active settings at dispatch | 1.50.1 | Groq / llama-3.3-70b-versatile | Adapter pins `smart_approve`; existing extensions/settings; no Gallivant OS sandbox | Same time bounds; no adapter USD cap | **Live adapter attempt blocked**, provider HTTP 404; no coding; resume blocked. |
| Goose, originally audited settings | 1.50.1 | custom_deepseek / deepseek-v4-pro | Same `smart_approve`; original provider/model pinned using native process flags | Same time bounds; no adapter USD cap | **Live adapter attempt blocked**, structured `creditsExhausted`; no coding; resume blocked. |
| Goose, saved Meta | 1.50.1 | meta / muse-spark-1.1 | `smart_approve`; existing extensions and native Meta credential lookup | Same time bounds; no adapter USD cap | **Live adapter attempt blocked**, HTTP 400 recursive tool-schema rejection; no retry/resume. |
| Goose, saved xAI | 1.50.1 | xai / grok-4.5 | `smart_approve`; native xAI credentials; CLI requires interactive approval | Same time bounds; no adapter USD cap | **Live adapter attempt blocked**, approval required on closed stdin; no retry/resume. |
| Goose, saved Alibaba | 1.50.1 | alibaba / qwen3.7-max | `smart_approve`; native Alibaba credential lookup | Same time bounds; no adapter USD cap | **Live adapter attempt blocked**, typed authentication error, HTTP 401; no retry/resume. |
| OpenCode, Console Meta | 1.18.31 | console-meta / muse-spark-1.1; Console BYOK, Responses SDK | Existing native permissions; no `--auto`; no Gallivant OS sandbox | Same time bounds; no adapter USD cap; billed cost unknown | **Live adapter attempt blocked**, native external-directory denial plus wrong tool directory before the runner fix; no retry/resume. |
| OpenCode, Console xAI | 1.18.31 | console-xai / grok-4.5; Console BYOK, Responses SDK | Same existing native permissions | Same time bounds; billed cost unknown | **Live adapter attempts failed**: initial wrong-directory writes; one corrected-directory retry stopped after attempted rebase against a contaminated local remote. No resume. |
| OpenCode, Console Alibaba | 1.18.31 | console-alibaba / qwen3.8-max; Console BYOK, Chat Completions SDK | Same existing native permissions | Same time bounds; billed cost unknown | **Live adapter attempts failed**: original stopped for directory isolation; retry authored/tested/committed/pushed in the correct checkout, but failed the external greeting assertion. No resume. |
| OpenCode, Tencent pending case | 1.18.31 | Tencent account product, eligible provider ID and exact model pending operator setup | No call or credential search; no permission changes | Not exercised | **Fixtures only for the harness; provider case untested/blocked.** Operator must identify an eligible account/API configuration and exact model before any call. |

The Goose config changed externally between the initial selector audit and dispatch. Its recorded modification time is `2026-10-01T00:24:16.906Z`; the initial audit saw `custom_deepseek/deepseek-v4-pro`, while dispatch saw `groq/llama-3.3-70b-versatile`. This task did not edit global settings. Both combinations have distinct rows and evidence. The second invocation appended only the original DeepSeek combination to the same bounded suite; it was not a retry of Groq and did not substitute a model for a failed case.

**Claude binary correction:** Gallivant config selects `/Users/uchi/.nvm/versions/node/v22.22.0/bin/claude`, which reports 2.1.263. PATH resolves `/Users/uchi/.local/bin/claude`, which reports 2.1.177. The original JSON retains its PATH-only observation as historical evidence; it does not establish a configured-binary failure. The live suite now uses configured binary paths when supplied and records PATH versions separately.

**Current operator scope:** DeepSeek is excluded from further calls; its historical results remain below. Tencent is deferred until the account product and credit type are established. The additional authorized cases use Goose's saved Meta, xAI and Alibaba selectors and the named OpenCode Console BYOK providers. A Console BYOK route is not an OpenCode Zen/Go subscription or a direct local vendor credential.

Tencent remains pending even though OpenCode is an advertised supported tool. The [Token Plan usage restrictions](https://www.tencentcloud.com/document/product/1300/81315) prohibit non-interactive batch/API scenarios outside their permitted scope; [the FAQ](https://www.tencentcloud.com/document/product/1300/81318) distinguishes Token Plan from TokenHub's free allowance. No eligibility is inferred from another provider's successful authentication or a model catalogue. The operator must establish the account product and this workflow's eligibility, then provide an existing eligible configuration through normal setup. No key was sought or invented.

## Historical run

The [sanitized machine-readable report](harness-live-validation.json) records commands, versions, both source snapshots and SHA-256 hashes of the uncommitted runner inputs, timestamps, session IDs, model evidence, original/corrected parser outcomes, costs, and external Git observations. Base revision: `650e2b3d5c2b898ed76e3f0d0d1f37b33c4f68fe`.

Suite interval: **00:26:36.926–00:32:12.056 UTC**, 335.130 seconds including the supplemental invocation. Five start attempts, zero resume attempts, zero targeted live retries. All turns were sequential and below 180 seconds. Metadata exports after the run made no model calls.

| Case | Start UTC | Elapsed seconds | Start result | Resume result | Reported cost USD |
|---|---|---:|---|---|---:|
| gemini | 00:26:39.013 | 57.992 | Stopped after workspace refusals | Blocked by start | unknown |
| opencode-default | 00:27:37.106 | 14.276 | Native permission auto-rejection | Blocked by start | 0.003868254 |
| opencode-go | 00:27:51.490 | 129.282 | Native permission auto-rejections | Blocked by start | 0.076778 |
| goose | 00:30:00.872 | 23.708 | Provider 404 | Blocked by start | unknown |
| goose-deepseek | 00:32:10.220 | 1.815 | Provider credits exhausted | Blocked by start | unknown |

Known reported cost totals **$0.080646254**; this is not the suite's total billed cost because three cases have unknown cost. Token counts of zero do not establish zero cost. OpenCode amounts sum every completed step, not just the final step. The JSON retains the original underreported last-step values for comparison.

For every checkout the external audit found: no function or test files, no commit beyond the initial empty fixture commit, no upstream, and an unborn bare remote HEAD. The working trees were clean only because no changes were made. Consequently no test was run by the external verifier against these failed checkouts; they are not passes. Exact initial/head SHAs are in each report record.

Raw evidence is private at `$TMPDIR/gallivant-live-harnesses-nI76KK` (the suite prints its canonical absolute path). The directory is mode 0700; logs, commands, session exports and ledger are 0600. It contains each case's `runs/<run-id>/{job.log,job.json,cmd.json}`, checkout and bare remote, verifier diagnostics, and native session exports. Do not commit these exports: they include prompts and session context. The public JSON contains only selected metadata and fixed diagnostic categories. Preserve this temporary directory privately before the operating system cleans temporary files.

## Failure diagnoses and operator remedies

- **Gemini — native workspace/tool boundary, not missing credentials.** The saved transcript identifies gemini-3.5-flash and real tool calls. `list_directory` refused `.git` as outside the allowed workspace, then refused the home directory. The process was stopped; the original run loop did not yet monitor refusals, so several rejected tool attempts appear before the stop. The final tooling now stops on structured boundary errors immediately. Operator remedy: review the recorded workspace/tool policy and provide a supported scoped non-interactive path for writes, `node --test`, and Git metadata operations in the disposable checkout/local remote. If the installed harness cannot express that scope, keep it blocked. Do not use yolo, broaden disk access, or retry the denied call.
- **OpenCode default — native external-directory permission rejection.** Reading the sibling `remote.git/{config,HEAD,refs}` triggered `permission requested: external_directory (.../remote.git/*); auto-rejecting`. **OpenCode Go/qwen — native external-directory permission rejection**, reported against `.../opencode-go/checkout/*`; two denied calls appear in the original stream. Operator remedy: inspect those exact requests and establish a supported, narrowly scoped approval path for the disposable checkout and local bare remote before authorizing a new suite. The suite does not add `--auto`, move the remote to evade the refusal, or change global permission policy.
- **Goose/Groq — provider rejection.** HTTP 404 said the selected model did not exist or was inaccessible. Operator remedy: verify access to **that exact** Groq model through normal provider setup. Choosing another model would be a new matrix case, not a successful retry.
- **Goose/DeepSeek — quota/credits (historical; excluded from further calls).** The native stream emitted a `systemNotification` with `notificationType: creditsExhausted`. No credentials were sought and no credits purchased. The latest operator instruction is to ignore DeepSeek, so this phase remains blocked with no retry planned.

Two initial adapter defects were fixed in `lib/harness.mjs`: OpenCode cost aggregation omitted earlier tool steps; Goose marked the observed HTTP error envelope and structured credits notification successful merely because a `complete` event followed them. `test/units.test.mjs` covers both cases, including every split of the provider-error envelope across streamed chunks (review 5373648819). Replaying saved streams yields corrected costs and failed outcomes. These parser fixes do not resolve external blocks, so **no extra live model calls were spent on them**.

OpenCode's large session export was truncated when stdout was a pipe. Directing the same read-only export to a private file produced complete JSON and confirmed qwen3.8-max. The metadata capture helper now uses file descriptors. Gemini's `init.model=auto` was not treated as a resolved model: its exact UUID's native transcript supplies gemini-3.5-flash.

## Additional Meta, xAI and Alibaba batches

The [additional sanitized records](harness-live-validation-providers.json) preserve all eight new starts, original and corrected outcomes, configured/PATH versions, model/session evidence, per-attempt source hashes, commands and external verification. Both batches launched from revision `04f55e11dd9008681763b0cbe04754cd17135ac8` with the recorded uncommitted source snapshots. The historical JSON remains unchanged.

Before calling Goose, its installed **v1.50.1** source was checked: [provider/model resolution](https://github.com/block/goose/blob/v1.50.1/crates/goose-cli/src/session/builder.rs) gives explicit `--provider`/`--model` precedence and instantiates that provider; the resume fallback applies only without an explicit provider. [Meta's definition](https://github.com/block/goose/blob/v1.50.1/crates/goose-providers/src/declarative/definitions/meta.json), [Alibaba's definition](https://github.com/block/goose/blob/v1.50.1/crates/goose-providers/src/declarative/definitions/alibaba.json) and [xAI's implementation](https://github.com/block/goose/blob/v1.50.1/crates/goose/src/providers/xai.rs) use their own credential names (`META_MODEL_API_KEY`, `DASHSCOPE_API_KEY`, `XAI_API_KEY`). No environment override was present for these names. The suite passes each saved selector explicitly and lets Goose load its native stored credential; it neither reads secret storage nor transfers keys to OpenCode.

The operator had already configured OpenCode's three named Console providers. The audit read only provider SDK names and model IDs, not auth values or Console routes. Meta/xAI use `@ai-sdk/openai`; Alibaba uses `@ai-sdk/openai-compatible`. Session exports report the exact named provider/model in each attempted turn. This demonstrates that those routes returned tool-capable responses; it does not establish an entitlement to other models or billing products. `console-alibaba/qwen3.7-max` was configured but not called; the selected OpenCode model remained qwen3.8-max. No Zen/Go alias was substituted.

Goose batch: **00:57:09.782–00:57:29.083 UTC**, 19.301 seconds. OpenCode batch, including both targeted retries and investigation: **01:01:26.881–01:13:53.478 UTC**, 746.597 seconds. Both stayed below 30 minutes; the longest additional turn was 164.551 seconds. Zero resumes. Raw evidence remains private under `$TMPDIR/gallivant-live-harnesses-LlfkcM` and `$TMPDIR/gallivant-live-harnesses-blFUMD`.

| Case / start attempt | Start UTC | Seconds | Result and remedy |
|---|---|---:|---|
| goose-meta / 1 | 00:57:12.652 | 9.291 | **Blocked:** HTTP 400, “Recursive JSON schemas are not currently supported.” Resolve native provider/tool-schema compatibility for this exact model; do not remove guards/extensions to evade it. |
| goose-xai / 1 | 00:57:22.243 | 4.455 | **Blocked:** `smart_approve` required an interactive terminal. Establish a supported scoped approval path for headless use; the CLI's suggestion to use Auto was not followed. |
| goose-alibaba / 1 | 00:57:26.864 | 2.095 | **Blocked:** HTTP 401, incorrect API key. Repair Alibaba's existing native Goose credential through normal setup before authorizing another suite. No key was inspected or moved. |
| opencode-console-meta / 1 | 01:01:32.027 | 19.482 | **Blocked:** native external-directory denial; also wrong tool directory. Resolve the exact scoped request before any new suite; no retry of the denial. |
| opencode-console-xai / 1 | 01:01:52.783 | 59.478 | **Failed:** shared runner inherited the PR worktree's `PWD`; wrong-directory edits and local Git changes. Recovered as documented below. |
| opencode-console-alibaba / 1 | 01:02:53.001 | 57.679 | **Failed/stopped:** same directory defect; interrupted when the isolation failure was investigated. |
| opencode-console-xai / 2 | 01:08:32.866 | 81.956 | **Failed/stopped:** correct tool directory, but the original attempt had contaminated the remote. The model continued after push failure and attempted rebase; dirty checkout, no upstream, mismatched remote HEAD. Retry exhausted; a future authorized suite must start with a pristine fixture. |
| opencode-console-alibaba / 2 | 01:11:05.820 | 164.551 | **Failed:** clean tested commit/push, but an ambiguous prompt omitted an explicit comma requirement enforced by the verifier. Prompt now states exact strings. Retry exhausted; no resume or further call. |

All additional billed costs are **unknown**. Goose supplied no cost. OpenCode emitted zero-valued native cost fields for the custom routes; these are preserved separately as `nativeReportedCostUsd`, not asserted to be zero billed BYOK cost.

Goose Alibaba exposed another justified parser defect: assistant content `{type: "error", kind: "authentication"}` followed by `complete` was marked successful. `Goose typed authentication error followed by complete is not success` now guards this shape, and saved-log replay records the corrected failure. No unchanged authentication/schema/approval rejection was retried.

The [directory incident, fix, and recovery](harness-live-validation-directory-fix.md) documents how OpenCode prefers inherited `PWD` over the process directory. `lib/run.mjs` now aligns child `PWD` with `cwd`, with a real-child regression that failed before the fix and passes afterward. Native export directory checks stop the batch on a mismatch. Historical OpenCode default and Go exports also identify the PR worktree; their original permission failures remain blocked, not reclassified as valid isolated coding tests. Neither historical denial was retried.

The first xAI attempt changed the PR worktree's origin and branch and created local probe commits. Pending edits were preserved, the original PR branch/index and origin restored, and the two accidental probe files removed after private backup. No successful GitHub push or default-branch change resulted. The later xAI retry attempted rebase only in its disposable checkout and was stopped; no rebase or force-push was used to recover this PR branch. A new preflight refuses nonempty remotes or prewritten/dirty start fixtures before any model call. The remote was not overwritten to make xAI pass.

The external audit found no files/commits/upstream in any Goose fixture or Console Meta fixture. xAI's retry has two files and passing tests but dirty state, no upstream, and a remote HEAD different from its local HEAD. Alibaba's retry has two passing tests, clean state, one commit whose parent is the fixture's initial commit, upstream `origin/gallivant/live-probe`, and matching local/remote HEAD `2babbab9c59738053a29836625673d99e053f790`. Its independent greeting check still fails: actual `Hello   Ada  !`, expected `Hello,   Ada  !`. The report preserves that failure and attributes the ambiguity to the test prompt; the check was not weakened after the fact. No combination qualified for same-session continuation.

## Repeat after resolving the recorded blockers

From a source checkout with existing local provider setup:

```sh
npm run test:live-harnesses -- --live
```

This runs Gemini's settings, OpenCode's current default, explicit `opencode-go/qwen3.8-max`, and Goose's current settings, blocking a selected DeepSeek provider/model before any call under the current operator exclusion. For the additional authorized provider cases, use separate harness batches:

```sh
npm run test:live-harnesses -- --live goose-meta goose-xai goose-alibaba
npm run test:live-harnesses -- --live opencode-console-meta opencode-console-xai opencode-console-alibaba
```

Select fewer case IDs to avoid unrelated calls. Missing `--live`, duplicate IDs and unsupported IDs are refused. The historical `goose-deepseek` case is no longer selectable. The named cases pin both turns to the same exact native provider/model, with no Zen/Go alias substitution. The suite does not log in or modify global config. Binaries may need the host's supported approval to write their normal session/cache files; this does not grant their tool requests blanket approval.

The runner reuses `buildRun`, `runEnv`, `makeRunner`, version probes and adapter outcome/session parsing, with ignored stdin. Every case has an empty disposable checkout and local bare remote. The prompt asks the model to author `greet` and tests, run tests, commit once and push. Resume requires the recorded identity, pins the provider/model, asks for trimmed-name behavior, and requires another tested commit/push. The external verifier checks both files, independent behavior, test output, ancestry, clean state, upstream and remote HEAD. It also requires a successful test tool result in the harness transcript; narration is insufficient. Goose's generated name is checked against the native exported stored ID on both turns; the other adapters must report the same stream session ID. No historical memory exercise is counted as this coding test.

One pair per selected combination is allowed. The suite shares a 30-minute deadline across append/retry invocations. Each turn reserves the runner's five-second TERM-to-KILL grace inside 180 seconds. A stopped/failed first turn blocks resume and makes the suite exit nonzero. For a demonstrated adapter defect only, record the fix and passing regression test in a repository file, then target one failed phase in the same ledger:

```sh
npm run test:live-harnesses -- --live --retry /absolute/private/suite-root CASE:start docs/audit/adapter-fix.md
```

Use `CASE:resume` to retry only a failed resume. One retry per combination is allowed; the source must have changed, external failures/denials cannot be retried, and the original deadline still applies. `--append /absolute/private/suite-root NEW_CASE` can add an untested combination within that same deadline. No retry or append starts unrelated phases. A new operator-authorized suite after remedy uses a new private directory and must be reported as new evidence.

New failed turns record the failing stage. Missing test-tool evidence and external
file, behavior, test or Git checks use the non-retriable `verification` category,
even when the adapter reports success and source files have since changed.
Recognized provider, permission and timeout failures retain their original
classification and remedy. An unclassified adapter-stage failure remains only a
candidate for investigation: a documented adapter defect, regression-tested fix,
source change and clean fixture are still required for a targeted retry. Legacy
unclassified records without a stage cannot qualify automatically. Historical
results and the two previously documented directory-fix retries are preserved;
no old record is relabeled to obtain another call.

The refusal classifier distinguishes an explicit permission request or rejection
from ordinary command stderr such as `bash: ./live.test.mjs: Permission denied`
or an `EACCES` file error. Those diagnostics remain in the private evidence, but
do not kill a turn or prescribe an approval remedy by themselves. A harness can
correct its command within the same turn and time budget. Explicit approval,
guardrail and sandbox refusals still stop the phase; this does not permit changing
policy or retrying a denied operation. Offline envelope tests cover Gemini,
OpenCode and Goose, and a disposable child verifies both command recovery and
termination on an explicit rejection. Historical live outcomes are unchanged.

An eligible start retry creates a distinct empty checkout and local bare remote
under the same private suite root. `previousStartFixture` retains the original
checkout/remote/initial-commit/session pointers; the first attempt's files, commits,
remote and logs are not reset or overwritten. New turn records include their
fixture pointers. Harnesses with caller-selected session names receive a fresh
start name, and any subsequent resume uses that successful retry's recorded identity.
The prepared retry fixture is checkpointed and still must pass pristine-start checks.
This does not grant another retry, reset the suite deadline, or permit a retry of
provider/permission failures. Resume retries still require the last passed state.

Suite checkpoints use the shared atomic JSON writer: a private temporary file is
written and flushed before replacing `report.json` by rename. A partial write,
process termination during the write, or rename failure leaves the last completed
checkpoint readable, including its earlier attempt history and retry reservations.
Offline fault injection exercises the actual suite entrypoint without provider calls;
both the ledger and any interrupted temporary file remain private.

Disposable fixture, turn, verifier and export environments clear inherited `GIT_*`,
`GH_*`, `GITHUB_*`, `SSH_*`, `GCM_*`, `VSCODE_GIT_*` and `VSCODE_SSH_*` variables,
including through the shared runner's parent-environment merge. This removes
GitHub tokens, SSH agent sockets and commands, askpass programs, editor credential
IPC handles, injected Git config/headers and client-certificate selectors.
The suite then restores only `runEnv`'s Git identity/config isolation and disposable
gh config path, and disables terminal credential prompts. Git is then restricted to
the `file` transport (`GIT_ALLOW_PROTOCOL=file`), and its SSH command is pinned to
`false`, so Git never falls back to default identity files or SSH config. `HOME`
and native provider setup remain intact. These child-environment controls do not
prevent an unrestricted process from overriding its environment, running raw SSH
or reading credentials on disk; native permission and sandbox boundaries are still
required. No operator settings were changed.

After all synchronous preflight work, a final check immediately before launch
requires usable suite time beyond the existing six-second termination reserve.
This also applies to automatic resume and targeted retries. An exhausted or
interrupted suite records the requested phase in `unstartedTurns`, preserves all
completed turns, and stops without a model call or consuming the retry allowance. The suite
deadline and 180-second turn cap are unchanged. Retry reservations remain durable
before launch, but the final check includes time spent saving them and releases
them when insufficient time prevents launch.

The suite awaits the runner's process-group kill fallback for every stop, including
watchdog and SIGINT/SIGTERM stops that already recorded exit 137. It waits before
metadata export, clearing the active run, or exiting an exceptional path. The
fallback also terminates surviving group members when the original leader exits
on SIGTERM. Interrupted turns remain blocked. Offline process-tree regressions
cover both a leader that ignores SIGTERM and one that exits ahead of its child.

Each invocation records its configured binaries and fresh version probes in the
private ledger's `invocations` array. Retry and append check only the selected
harnesses, once per harness, using the current configuration and shared version
probe. Unsupported, unreadable or missing binaries block calls before fixture
creation or retry reservation, with the required version and binary path recorded
as the remedy. New turns reference their invocation; earlier turns and the original
version/PATH audit remain unchanged. Offline executable probes cover binary-path
changes, upgrades, downgrades and failed probes without using a provider.

After upgrading an unsupported binary, the same `--append` command can reuse its
version-blocked entry only when it has no turns, retry reservation or fixture yet.
The recorded provider/model, requested session and original suite deadline remain
unchanged. A spent turn, another kind of block, or exhausted deadline still prevents
this path from making a call; a version change does not grant an additional attempt.

Every resume, including a targeted retry, now checks the last passed turn's Git
state before launching a model call or consuming the retry allowance. The checkout
must be clean at that recorded commit on the probe branch, with the same upstream,
local bare origin, push destination, remote branch and remote HEAD. Partial edits,
commits or pushes from a failed resume stop the suite; the preflight preserves the
failed-turn evidence and does not reset or overwrite it. Resolve the cause and
obtain authorization for a fresh suite if the saved state no longer matches.
Offline regression `live resume preflight accepts only the last passed checkout
and remote without changing either` covers the valid state and thirteen rejection
cases. This review fix made no model calls and does not alter any live result.

## Remaining lifecycle validation

These disposable live adapter tests **do not prove GitHub review or completion behavior for each harness**, even if both turns eventually pass. Gemini, OpenCode and Goose still need an explicitly authorized small Gallivant PRD through `gallivant ready`, `gallivant start`, PR creation, a real review/CI-triggered same-session fix, a pushed revision, and the completion/ready-for-human gate. That is future work; only this task's PR was authorized for GitHub writes here. Claude/Codex production evidence was cited without repeat calls.

The ordinary `npm test` glob excludes both live entrypoints. Offline regression tests cover rejection of false file/Git successes, changed session identities, model fallbacks, narrated test success, and the observed adapter failures. Final normal-test, lint, whitespace and credential-scan results are recorded in the PR receipt. AC-2 and AC-3 remain false until actual successful start/resume evidence exists.

## Completion gate disposition

The criteria denial is valid: AC-2 and AC-3 are requirements this PR has not achieved.
Neither is an incorrect criterion, and a corrected receipt cannot create missing
live evidence. AC-4 and AC-5 require unavailable phases to remain blocked or failed;
they do not turn them into successful coding or continuation runs. The receipt
therefore retains both false attestations, and the PR must remain incomplete.

Before another bounded suite, the operator must resolve the recorded native
approval/workspace restrictions for Gemini, Goose xAI and the denied OpenCode
cases, repair Goose Alibaba's native authentication, and address Goose Meta's
tool-schema compatibility. Existing provider access/credit failures remain
blocked; DeepSeek is excluded and Tencent is deferred. The two Console cases
that used a targeted retry have exhausted that allowance. A fresh suite requires
explicit operator authorization after the applicable remedies, using pristine
fixtures and the corrected prompt. No further calls were made in response to the
gate denial, and no guard or policy was relaxed.

The output-pattern finding came from zero-count test-summary labels. Those labels
were clarified without changing the recorded counts; raw command output remains
private. Intentional progress messages now use direct stream writes to comply
with the existing output scan. The configured pattern list and gate evaluator
were not changed. Removing those reporting matches resolves only the pattern
finding, not the missing live start/resume evidence.
