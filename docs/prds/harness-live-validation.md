---
status: ready
harness: codex
aport_decision: 58adf677-2102-40bd-8ef1-2828749c11f5
---

# Validate supported harnesses with real coding runs

## Problem

Gallivant advertises Claude Code, Codex, Gemini CLI, OpenCode and Goose, but argument and event-fixture tests alone do not establish that each can complete unattended coding work on this machine. Claude and Codex have completed production tasks. The other installed harnesses need reproducible live evidence of edits, tests, Git writes and same-session continuation, with failures distinguished from missing provider setup. Operators need a truthful support matrix before trusting new work to them.

## User stories

- As an operator, I want real start and resume tests for every advertised harness, so that support means demonstrated behavior rather than accepted flags.
- As a maintainer, I want a repeatable validation command and an evidence report, so that future adapter upgrades can be checked without running expensive tests in ordinary CI.

## Acceptance criteria

- Given the five advertised harnesses, when their current implementation and installed versions are audited, then a support matrix has a separate row for every harness/provider/model combination tested and records each version, configured provider/model when knowable without exposing credentials, permission boundary, available budget enforcement, and whether evidence is production, a live adapter test, or fixtures only. Preserve the distinction between a harness integration and a provider subscription.
- Given Gemini CLI, OpenCode and Goose with existing local settings, when the opt-in live suite runs, then each performs a real small coding task through Gallivant's existing buildRun, run environment and outcome/session parsing. In its own disposable Git checkout with a local bare remote, it writes a tiny function and test, runs the test, commits and pushes; an external verifier checks files, test results, clean Git state, commit, upstream and remote HEAD. A help command, mock model, narrated success or prewritten change does not count as a passing live test.
- Given a successful first turn, when the same harness resumes its recorded session, then it changes the behavior in a second real turn, updates and passes the test, commits and pushes again. Verify the session identity using the adapter's actual identity contract and show evidence for both turns. A new session, lost work or approval prompt waiting on closed stdin fails that phase.
- Given a failure, when it is investigated, then distinguish an adapter defect from missing credentials, provider rejection, quota, permissions or sandbox restrictions. Fix justified adapter defects using the existing shared architecture and regression tests, then repeat only affected live phases. If an external requirement prevents completion, record that phase as blocked or failed with the exact operator remedy; do not mark the affected harness live-verified, silently skip it, or weaken safety checks to turn it green.
- Given model calls in the live suite, when the suite executes, then it is opt-in, outside the ordinary test glob, sequential, bounded by a maximum of 180 seconds per harness turn and 30 minutes for the suite, and limited to one start/resume pair per selected harness/provider/model combination plus one targeted retry after a justified fix. Test existing Gemini and Goose settings, OpenCode’s existing default, and OpenCode Go with qwen3.8-max. Keep the chosen provider/model constant across start and resume and verify the effective model from available output. Mark unavailable cases blocked rather than silently substituting another model. Preserve raw logs privately outside the repository; commit a sanitized report with timestamps, commands, version and source revision, outcomes, elapsed time, cost when available, and evidence locations. Unknown cost is reported as unknown, not zero.
- Given the report, when documentation is updated, then README and architecture instructions match demonstrated support, clearly label unverified or blocked capabilities, and state that these disposable live adapter tests do not themselves prove GitHub review/completion behavior for each harness. Add the exact command for repeating the live tests and any next step needed for a full Gallivant PR lifecycle. Existing Claude/Codex production evidence may be cited without spending calls to repeat it.
- Given the final change, when normal tests and lint run, then both pass, no provider key or raw credential appears in tracked changes, and one reviewable PR contains the test tooling, justified fixes and evidence report with a truthful completion receipt.

## Verify

- `npm test`
- `npm run lint`
- `git diff --check`

## Where to look

- `lib/harness.mjs`, `lib/probe.mjs`, `lib/run.mjs`, `lib/git.mjs` and `lib/commands/start.mjs` own production dispatch. Reuse their contracts; do not build a second runner or provider client.
- `test/live-codex-git.mjs` already proves real model-driven Git writes against a disposable local remote. Extend or share its fixture where useful without making normal tests require credentials.
- `test/units.test.mjs`, `test/probe.test.mjs` and `test/resume.test.mjs` cover argument, stream and readiness contracts.
- `README.md`, `SPEC.md` and `docs/architecture.md` contain support claims; SPEC section 6.6a explicitly says per-task model selection is not built.
- Local inventory: Gemini 0.59.0, OpenCode 1.18.31 and Goose 1.50.1 are installed on PATH. Gallivant's operator config enables only Claude and Codex. OpenCode stores Zen and Go connections. Goose selects custom_deepseek with deepseek-v4-pro. The installed OpenCode catalogue lists both opencode/qwen3.8-max and opencode-go/qwen3.8-max; use the latter for the additional requested model case. Use existing local credentials and native per-process model overrides only; a failed credential check must not trigger secret hunting or account changes.
- Tencent's current Token Plan restriction: https://www.tencentcloud.com/document/product/1300/81315 . Its FAQ separates Token Plan from TokenHub free allowance: https://www.tencentcloud.com/document/product/1300/81318 . The operator also requested a Tencent model supported by its coding plan. Prepare a separate OpenCode matrix row, but its local credential location and exact account product are still pending; do not invent or search for a key. The international guide lists glm-5.2, kimi-k2.6 and deepseek-v4-pro-202606 at https://www.tencentcloud.com/document/product/1300/81036 ; the China Coding Plan guide lists glm-5, kimi-k2.5 and minimax-m2.5 at https://cloud.tencent.com/document/product/1823/130096 . A supported tool or model is not proof that the unattended test is permitted by that subscription. Record Tencent as pending operator setup/eligibility unless an existing eligible API configuration is supplied.

## Out of scope

- Changing global Gallivant or harness configuration, retrieving benchmark secrets, buying credits, or inventing a general per-task model selector. A test-local native model override for the requested OpenCode cases is in scope; global default or permission changes are not.
- Removing hooks, changing guardrail policy, bypassing a denial, enabling blanket approval or full disk access. A sandbox/tool denial is evidence to report; supported scoped approval remains available where the harness permits it.
- Other repositories, deployments, paid benchmarks, parallel harness calls, scheduling, or interactive login. Only this task's Gallivant PR may be written to GitHub; child probes push solely to their disposable local remotes.
- Publishing private raw logs, arbitrary configuration files or credentials. Report provider names and sanitized diagnostics only.
