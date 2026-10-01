# Validate supported harnesses with real coding runs

Audit: 2026-10-01 UTC (2026-09-30 in America/Toronto). Scope: [PRD](../prds/harness-live-validation.md).

**No newly tested combination is live-verified.** Five start turns were attempted, all blocked before creating the requested files. No resume turn was eligible. The tooling and parser regressions are verified; the PRD's successful coding and continuation criteria remain unmet. No denial was retried and no permission setting was relaxed.

## Support matrix

An adapter is a harness integration, not a provider subscription. A working CLI, catalogue entry, login, or supported-tool listing does not establish model access, available credits, permission for unattended use, or a completed Gallivant lifecycle.

| Harness | Installed version | Provider / model | Permission boundary | Available budget enforcement | Evidence and demonstrated support |
|---|---|---|---|---|---|
| Claude Code | 2.1.177; adapter minimum 2.1.263 | Existing production provider/model not recorded; current model setting unset | Gallivant settings sandbox, auto permission mode, no interactive prompts, existing APort hooks | Native USD cap plus Gallivant wall clock | Existing production evidence reported in the PRD and [PR #3](https://github.com/uchibeke/gallivant/pull/3); no new calls. **Current installed version fails preflight**; upgrade to at least 2.1.263 before dispatch. |
| Codex | 0.158.0 | Current config: OpenAI default provider / gpt-6-astra; production run's exact model unknown | workspace-write, on-request escalation through auto_review, network enabled; existing hooks retained | Wall clock; no adapter USD cap | Existing production evidence in PRD/[PR #3](https://github.com/uchibeke/gallivant/pull/3), plus its earlier disposable Git start/resume probe. No calls repeated here; current configured model is not attributed to historical runs. |
| Gemini CLI | 0.59.0 | Gemini API-key auth / `auto` resolved to gemini-3.5-flash | Existing native workspace/tool policy; trust flag only, no yolo or new grants | 180 seconds/turn, 30 minutes/suite; no adapter USD cap | **Live adapter attempt blocked**, start: workspace refusals; resume blocked. Earlier event/session fixtures are not coding proof. |
| OpenCode, existing default | 1.18.31 | OpenCode Go / deepseek-v4-flash | Existing native permissions, no `--auto`; external-directory request auto-rejected on closed stdin; no Gallivant OS sandbox | Same time bounds; no adapter USD cap; cost reported per step | **Live adapter attempt blocked**, start: permission refusal on sibling remote; resume blocked. |
| OpenCode, explicit Go case | 1.18.31 | OpenCode Go / qwen3.8-max | Same existing native permissions; no new grants | Same time bounds; per-step cost | **Live adapter attempt blocked**, start: external-directory permission refusals; resume blocked. Export confirms `opencode-go`, not Zen's similarly named model. |
| Goose, active settings at dispatch | 1.50.1 | Groq / llama-3.3-70b-versatile | Adapter pins `smart_approve`; existing extensions/settings; no Gallivant OS sandbox | Same time bounds; no adapter USD cap | **Live adapter attempt blocked**, provider HTTP 404; no coding; resume blocked. |
| Goose, originally audited settings | 1.50.1 | custom_deepseek / deepseek-v4-pro | Same `smart_approve`; original provider/model pinned using native process flags | Same time bounds; no adapter USD cap | **Live adapter attempt blocked**, structured `creditsExhausted`; no coding; resume blocked. |
| OpenCode, Tencent pending case | 1.18.31 | Tencent account product, eligible provider ID and exact model pending operator setup | No call or credential search; no permission changes | Not exercised | **Fixtures only for the harness; provider case untested/blocked.** Operator must identify an eligible account/API configuration and exact model before any call. |

The Goose config changed externally between the initial selector audit and dispatch. Its recorded modification time is `2026-10-01T00:24:16.906Z`; the initial audit saw `custom_deepseek/deepseek-v4-pro`, while dispatch saw `groq/llama-3.3-70b-versatile`. This task did not edit global settings. Both combinations have distinct rows and evidence. The second invocation appended only the original DeepSeek combination to the same bounded suite; it was not a retry of Groq and did not substitute a model for a failed case.

Tencent remains pending even though OpenCode is an advertised supported tool. The [Token Plan usage restrictions](https://www.tencentcloud.com/document/product/1300/81315) prohibit non-interactive batch/API scenarios outside their permitted scope; [the FAQ](https://www.tencentcloud.com/document/product/1300/81318) distinguishes Token Plan from TokenHub's free allowance. No eligibility is inferred from another provider's successful authentication or a model catalogue. The operator must establish the account product and this workflow's eligibility, then provide an existing eligible configuration through normal setup. No key was sought or invented.

## Recorded run

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
- **Goose/DeepSeek — quota/credits.** The native stream emitted a `systemNotification` with `notificationType: creditsExhausted`. Operator remedy: restore credits/access for the existing custom_deepseek configuration, or wait for its quota reset as applicable, then explicitly authorize a new suite. No credentials were sought and no credits purchased.

Two justified adapter defects were fixed in `lib/harness.mjs`: OpenCode cost aggregation omitted earlier tool steps; Goose marked the observed HTTP error envelope and structured credits notification successful merely because a `complete` event followed them. `test/units.test.mjs` covers both cases. Replaying the saved streams through the corrected parsers yields the costs and failed outcomes recorded in the report. These fixes do not resolve the external permission/quota/provider blocks, so **no extra live model calls were spent on them**.

OpenCode's large session export was truncated when stdout was a pipe. Directing the same read-only export to a private file produced complete JSON and confirmed qwen3.8-max. The metadata capture helper now uses file descriptors. Gemini's `init.model=auto` was not treated as a resolved model: its exact UUID's native transcript supplies gemini-3.5-flash.

## Repeat after resolving the recorded blockers

From a source checkout with existing local provider setup:

```sh
npm run test:live-harnesses -- --live
```

This runs Gemini's settings, OpenCode's current default, explicit `opencode-go/qwen3.8-max`, and Goose's current settings. The exact command for the PRD's originally audited Goose model, irrespective of a later active-provider change, is:

```sh
npm run test:live-harnesses -- --live gemini opencode-default opencode-go goose-deepseek
```

Select fewer case IDs to avoid unrelated calls. Missing `--live`, duplicate IDs and unsupported IDs are refused. `goose-deepseek` uses `--provider custom_deepseek --model deepseek-v4-pro`; it requires that existing provider setup. The suite does not log in or modify global config. Binaries may need the host's supported approval to write their normal session/cache files; this does not grant their tool requests blanket approval.

The runner reuses `buildRun`, `runEnv`, `makeRunner`, version probes and adapter outcome/session parsing, with ignored stdin. Every case has an empty disposable checkout and local bare remote. The prompt asks the model to author `greet` and tests, run tests, commit once and push. Resume requires the recorded identity, pins the provider/model, asks for trimmed-name behavior, and requires another tested commit/push. The external verifier checks both files, independent behavior, test output, ancestry, clean state, upstream and remote HEAD. It also requires a successful test tool result in the harness transcript; narration is insufficient. Goose's generated name is checked against the native exported stored ID on both turns; the other adapters must report the same stream session ID. No historical memory exercise is counted as this coding test.

One pair per selected combination is allowed. The suite shares a 30-minute deadline across append/retry invocations. Each turn reserves the runner's five-second TERM-to-KILL grace inside 180 seconds. A stopped/failed first turn blocks resume and makes the suite exit nonzero. For a demonstrated adapter defect only, record the fix and passing regression test in a repository file, then target one failed phase in the same ledger:

```sh
npm run test:live-harnesses -- --live --retry /absolute/private/suite-root CASE:start docs/audit/adapter-fix.md
```

Use `CASE:resume` to retry only a failed resume. One retry per combination is allowed; the source must have changed, external failures/denials cannot be retried, and the original deadline still applies. `--append /absolute/private/suite-root NEW_CASE` can add an untested combination within that same deadline. No retry or append starts unrelated phases. A new operator-authorized suite after remedy uses a new private directory and must be reported as new evidence.

## Remaining lifecycle validation

These disposable live adapter tests **do not prove GitHub review or completion behavior for each harness**, even if both turns eventually pass. Gemini, OpenCode and Goose still need an explicitly authorized small Gallivant PRD through `gallivant ready`, `gallivant start`, PR creation, a real review/CI-triggered same-session fix, a pushed revision, and the completion/ready-for-human gate. That is future work; only this task's PR was authorized for GitHub writes here. Claude/Codex production evidence was cited without repeat calls.

The ordinary `npm test` glob excludes both live entrypoints. Offline regression tests cover rejection of false file/Git successes, changed session identities, model fallbacks, narrated test success, and the observed adapter failures. Final normal-test, lint, whitespace and credential-scan results are recorded in the PR receipt. AC-2 and AC-3 remain false until actual successful start/resume evidence exists.
