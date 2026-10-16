# Guardrails

Review learning adds a separate signature boundary, not a new permission source.
Workers may propose data but cannot enroll keys, write trust/checkpoints or activate
memory. File modes and TTYs alone do not isolate a same-UID arbitrary-shell worker;
native escalation and control routes must also be excluded. Current adapters are
UNQUALIFIED for learning application and remain collection only. OpenSSH signing
pins the executable, removes agent/askpass/loader variables, requires an encrypted
dedicated key and verifies exact canonical content before activation and dispatch.
An explicit `resume --fresh-session` requires settled ownership and cannot clear
unrelated stop fences or reset cumulative execution allowance. Lost replies use
the same session-identity checks as submission. This does not qualify an otherwise
unsupported learning profile.
See [learning](learning.md) for limits, recovery and actual missing qualification.

Unattended runs act with your GitHub identity on your repository. Controls depend
on the execution provider: local Claude and Codex have the sandbox/hook setup
described below; Gemini, OpenCode and Goose retain their native permission models
and do not inherit those guarantees merely because an adapter exists. Hosted
Agents has a separate sandbox/artifact-publication boundary described next.
The APort pre-tool hook and deliverable-completion gate are separate controls.

## Hosted execution and preparation

Hosted Agents receives the approved source snapshot and configured network/package
policy, not the coordinator's GitHub/API credentials, private context directories
or local hook files. The coordinator checks ownership, input revision, artifact
paths/hashes and mandatory Verify results before publishing with its own scoped
GitHub credential. Native sandboxed verification must qualify on the coordinator
host; it never falls back to running repository commands unrestricted.
Provider success is not a completion verdict. See [execution](execution.md) and
[Agents setup](openai-agents.md) for the exact contract and remaining live gates.

A remote provider is refused when the task requires a local policy it cannot
enforce. Codex Cloud currently refuses all new dispatch because the selected
Cloud environment cannot be verified against the intended repository. Neither a
completion receipt nor a manual UI observation substitutes for that binding.

Natural-language preparation uses a narrower boundary than implementation:
Claude tools-off, isolated Codex profile or Agents text-only/no-environment.
Selected text grants no implementation authority. Unknown or unsupported
preparation capabilities fail closed. See [preparation](preparation.md).

## Local execution controls

This table describes local Claude/Codex setup unless another provider is named.

| Guarantee | Control | APort's part |
|---|---|---|
| Filesystem access is bounded | Claude: the Bash sandbox in the Gallivant settings file. Codex: `workspace-write`, with boundary-crossing commands reviewed by Codex's automatic reviewer. An approved command runs outside that sandbox; the reviewer is a decision, not filesystem isolation. | Denies Write and Edit tool calls outside `allowed_paths`. Does not see `echo x > ~/.zshrc` inside a Bash command. |
| Reads of secrets are restricted | The sandboxes and each harness's denied reads; Codex's automatic reviewer checks escalation requests for credential probing. This is not a guarantee about an approved command running outside the sandbox. | Applies default sensitive-file restrictions and `data.file.read.blocked_patterns` to represented file reads. Directory enumeration and unrepresentable calls can be refused. Does not see `cat .env` inside Bash. |
| Network limited | Claude: `sandbox.network.allowedDomains`, with the macOS certificate-service exception described below. Codex: none once `network_access=true`, which `git push` needs. | Denies WebFetch and WebSearch outside `allowed_domains`. Does not see `curl` inside Bash. |
| No push to the default branch, no force push | A GitHub ruleset on each repo: no deletion, no force push, pull request required, no bypass actors. `doctor` prints the call. Sessions are also told not to rebase, because keeping a branch on its base is the daemon's job and it does it with a merge commit, which needs no force. | `blocked_patterns` checks command text using word-boundary/glob matching for single words and literal matching for phrases such as `push --force`. Best effort; APort does not parse refspecs. |
| Blast radius of a successful injection | Optional but recommended: a fine-grained PAT limited to the participating repos with no Workflows permission (`github_token_file`). By default runs act as your own login, which reaches every repo it can. Either way the credential is resolved by the daemon and handed to the run in its environment, so `~/.git-credentials`, the keychain and `~/.config/gh` stay out of a run's path. | An audit log of every tool call, for reconstruction. |
| Runtime and dispatch bounds | Claude's `--max-budget-usd`, `run_timeout_minutes` for local runs (per repository or global; default 720), and `max_iterations` per PR. Other local harnesses have no native dollar hard cap. Remote reservations bound further dispatch, not provider billing. | none |
| No harness attribution in the history | A `commit-msg` hook in each checkout's `.git/hooks`, written at clone time and on every reuse. A message with a `Co-Authored-By:` trailer naming a harness or its vendor, or a "Generated with" / robot line, exits non-zero and no commit object is created. The hook applies to local commits regardless of which harness invoked Git; hosted results also pass coordinator public-output validation. | none |
| Commits are yours, not a bot's | `user.name` and `user.email` in the run env, on git's command line where no repo can override them, resolved per run from your own git config by the daemon. No identity on the machine means the run is refused before it is spawned. | none |

## Codex Git writes need automatic approval

Codex protects `.git` even inside a `workspace-write` checkout. Gallivant therefore pins
`approval_policy="on-request"` and `approvals_reviewer="auto_review"` for **both start and resume**. The sandbox
stays enabled. Codex's own reviewer decides whether an escalation may run, without waiting for an operator click.
A reviewer or guardrail refusal still means stop and report; changing permissions or bypassing the sandbox is forbidden.
Start, manual resume and the daemon check the configured binary's version and sign-in before launching work. An old
or unreadable version stops the launch with an upgrade instruction; the minimum is enforced, not just listed by `doctor`.
This is the [documented automatic-review path](https://learn.chatgpt.com/docs/sandboxing/auto-review), not a grant
of unrestricted access. Review calls can add usage and latency, and managed Codex policy can refuse them.

The previous `approval_policy="never"` stranded runs at `.git/index.lock`, `.git/config`, and remote-tracking ref
updates. Saved command allow rules made some simple Git commands work, while compound commands containing heredocs
still failed. A successful remote push could even exit zero after its local tracking update failed. Gallivant's shared
prompt now distinguishes a sandbox error from a policy denial, asks for the supported approval path, and requires
checking the staged diff, remote HEAD, and upstream. No personal command allow rules are required by Gallivant.

The real start/resume regression probe uses the adapter and run environment against a disposable local bare remote:

```bash
node --test test/live-codex-git.mjs
```

Run it from a Gallivant clone with Codex signed in. It spends model calls, makes no GitHub writes, and prints the
temporary directory holding its logs and test repository. It is deliberately separate from `npm test`. `doctor`'s
credential probe uses `git ls-remote`; that checks authentication, not Codex's Git write permissions.

## Claude on macOS needs certificate verification

Claude's macOS sandbox blocks the Apple trust service used by Go programs such as `gh`. A run can therefore fail
with `tls: failed to verify certificate: x509: OSStatus -26276` even when its GitHub credential is valid and `curl`
works. The Claude settings template enables `sandbox.enableWeakerNetworkIsolation` to permit
`com.apple.trustd.agent`. This is a native Claude setting in the existing operator-owned settings file, loaded for
both start and resume. `doctor` detects its absence on macOS; Linux does not require it.

This permission has a real cost: [Anthropic's sandbox runtime documentation](https://github.com/anthropics/sandbox-runtime#configuration-options)
warns that it opens a potential exfiltration route through the trust service. The filesystem sandbox and domain
allowlist remain configured, but the allowlist does not bound this additional route. TLS certificate verification
stays enabled. Keep this grant in Gallivant's operator-owned Claude settings, outside the agent's writable checkout.
Do not disable the sandbox or exclude `gh` from it to repair certificate errors.

Harness adapters already translate Gallivant's shared run lifecycle into each CLI's native permissions. This
Claude/macOS requirement belongs to that setup; it adds no task-specific switch or alternative completion path.
APort's pre-tool policy and Gallivant's deliverable-completion gate remain separate checks.

## How a run gets a GitHub credential

For local CLI implementation, the run's Git credential helper does not read a credential store. The daemon resolves a credential and puts it in the run's environment as `GH_TOKEN`, where a git credential helper carried in the same environment reads it. No file outside the worktree is named, so sandboxed Git does not need the keychain, the Linux secret service, `~/.git-credentials` or `~/.config/gh`. Agent runs also set `GH_CONFIG_DIR` inside the private clone so the GitHub CLI can use that token without loading the operator's personal config; this applies to start, resume and fix rounds. Order and details are in [config.md](config.md#github-credentials).

What bounds the credential, and what does not:

- **A scoped token still wins.** `github_token_file` is checked before anything else, so a token you deliberately narrowed is never replaced by a wider one the daemon could also have found.
- **The token is not in argv.** `ps` shows argv to every process on the machine, including processes owned by other users.
- **The token is not in any log.** `job.log` is the run's own stdout and is rendered in the tracker; `cmd.json` records the command and arguments and no environment. Anything that reports on a credential reports its source and length.
- **A run cannot widen its own access.** The passport blocks reads of `~/.gallivant/**` and `~/.claude/**`, so the config that names the token file, and the token file itself when it lives there, are not readable from inside a run. Resolution happens in the daemon before the child exists.
- **The run's git config reaches nothing outside the worktree.** The four settings a run needs, credential helper included, travel in the environment as git's own `GIT_CONFIG_COUNT` pairs. `GIT_CONFIG_NOSYSTEM=1` drops git's system file, which on a Mac with the Xcode command line tools sets `credential.helper = osxkeychain`; without it a run had a path to your keychain whatever else was configured.
- **What it does not bound.** The credential is in the environment of a process the agent controls, so a successful injection can read it and use it for anything the token permits. That is also true of a token file the run could read, and of a credential helper the run could invoke; the environment is not worse, it is the same exposure with one fewer copy on disk. Nor does the run's git config bound it: a run owns its worktree, so it can add its own `credential.helper` to `.git/config`, which git consults first because that key is multi-valued. That was equally true when the helper lived in a global file. The controls that actually bound it are the token's own scope, which is why a fine-grained PAT limited to the participating repos is the recommendation, and the GitHub ruleset, which stops a push to the default branch whatever the token permits. Transport is not a control; scope and the ruleset are.

A local run that cannot get a credential does not start. Hosted publication
resolves that credential only in the coordinator; it is not copied into the hosted
sandbox. Spending a budget on work that cannot be published is not a useful default.

`doctor`'s `run git push` line checks the credential transport. It runs `git ls-remote` against the first configured repository with the run's environment and `HOME` pointed at a path that does not exist. It does not run inside Codex's sandbox or prove Git write access. On failure it prints git's own words: the message git prints when it has no credential names `~/.git-credentials`, which is not always the file it failed on.

## What must be delivered

Before a PR can be ready for a human, the daemon evaluates a completion receipt in the PR body against the PRD's acceptance criteria, following APort's `deliverable.task.complete.v1` policy: one attestation with evidence per criterion, a summary, and tests green as observed by the daemon. See [prd.md](prd.md). It is a gate on what the agent must deliver, not a security boundary; the table above is the boundary.

## What reaches a prompt

GitHub feedback is filtered by `trusted_authors`, the configured reviewer bot
and the shared event cursor. Ordinary issue comments trigger work only through a
recognized fix command. The daemon's marked comments and the harness's own thread
replies are excluded. Editing an old comment does not make it new: creation time,
not edit time, governs the cursor. Feedback received during a run is handled under
the same deduplication and head/receipt rules; receipt-only corrections preserve
pending feedback rather than discarding it.

Failing checks are named with their run ID; local harnesses fetch their logs.
Quoted GitHub text uses a four-backtick fence with internal fences neutralized
and a 4,000-character cap. This is prompt hygiene, not an injection guarantee;
provider permissions, token scope and repository rules remain the authority
boundary.

## Extra read directories are a widening, not a feature

`context_paths` lets you hand a session read access to directories outside its checkout: a sibling repository it has
to call into, a folder of design notes, an API schema it must match. Writes do not move. On Claude Code the paths go
through `--add-dir`, and the sandbox in the Gallivant settings file still bounds every write to the worktree.

What it costs. Reading is an exfiltration path. Anything the agent reads can come back out in a commit, a PR body,
a comment or a run log, and a prompt injection in a review comment is enough to ask for it. A private key in a
directory you added is a private key in a public PR. So the recommendation is a narrow one: name the directory the
brief actually needs, not the parent that happens to contain it. `~/work/schemas` rather than `~/work`.
`~/Projects/design-system` rather than `~/Projects`.

Five paths are refused outright, and each refusal names what it protects:

| Refused | Because |
|---|---|
| The Gallivant home, or any parent of it | It holds the registry, the run logs and `claude/settings.json`, the sandbox definition that bounds the run's writes. A run that can read it can read the rules it is being held to. |
| `~/.claude`, `~/.codex`, `~/.config/opencode` | Harness credentials and config. These are already in the passport's `blocked_paths`; refusing them here means the read never gets as far as the hook. |
| `~/.aport` | The passport itself, and the audit trail. |
| Your home directory | Every credential, token, key and browser profile on the machine. If the answer to "which directory does this brief need" is `$HOME`, the brief needs splitting, not more access. |
| Anything relative, or that does not exist | A relative path means something different depending on where the daemon was started. A missing one is a typo, and silently granting nothing would hide it. |

Every one of those refusals compares the path with its symlinks resolved, not the path as written, because a link to `$HOME` or to `~/.claude` is the thing being refused however it is spelled.

A parent of a refused directory is refused too, since granting the parent grants the child.

What each harness does with the list:

| Harness | Effect |
|---|---|
| Claude Code | `--add-dir <dir>` per path. Read access widens, the sandbox still bounds writes. |
| Codex | Refused. `--add-dir` makes a directory **writable**, and the only read permission Codex documents is `disk-full-read-access`, the whole disk. Giving a run the entire filesystem to read in order to hand it one directory is worse than the problem; the run fails with that explanation instead. |
| Gemini CLI | Refused, for the same shape of reason. `--include-directories` adds to the *workspace*, and Gemini's own file-system tool reference says every file tool, `write_file` included, operates inside the workspace root. There is no read-only spelling. |
| opencode, goose | No directory flag exists, so the list has no effect. The run proceeds unchanged rather than failing over a setting the CLI cannot honour, and `gallivant doctor` says so per harness when you have a list configured. |
| Hosted providers | Private local `context_paths` are refused. Supply authorized portable repository documents through the supported source snapshot instead. |

Nothing here escalates quietly. A harness that cannot do what was asked either refuses the run or reports that the
setting did nothing. In the daemon a refusal stops that entry with the reason `context-paths`, since the same
refusal would come back on every poll; `gallivant why <handle>` prints it.

A PRD can add to the list for itself with a `context_paths:` key in its frontmatter, held to exactly the same
refusals. It is the operator's list either way: the daemon's fix rounds read the snapshot of the brief taken when
the run started, not the copy in the checkout, so a session cannot widen its own reads by editing the PRD it was
given.

## Recovery from GitHub is guarded

On boot, `up` registers only PRs authored by the token's login, with same-repo heads, on `work/*` or legacy `gallivant/*` branches, whose decoded recovery block passes strict validation (harness-specific session, repository-relative Markdown PRD path, known harness). Iteration is recovered by counting the daemon's own marked comments, never read from the block, so editing a PR body cannot reset the cap.

## The passport

`templates/passport.gallivant.json`: capabilities for file read and write, command execution, web fetch and subagent creation. `allowed_commands` is `["*"]` on purpose: a restrictive list denies any command containing `&&`, `;` or `|`, so the first `git add -A && git commit` of every run would fail. Write `allowed_paths` is the worktrees root.

`data.file.write.blocked_paths` and `data.file.read.blocked_patterns` cover
`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.gallivant` and `~/.aport`.
These are different policy fields: the local read evaluator does not enforce
`blocked_paths`. Existing local passports copied from older templates must move
their read list to `blocked_patterns`; rerun `doctor` afterward. The directories
hold credentials and operator-owned rules, so the represented read and write
tools need both restrictions. Shell commands remain subject to the separate
sandbox and command policy, as described above.

That template is the **local-mode default**, and `doctor` checks both policy
fields on `<aport dir>/passport.json`, naming missing restrictions. A **hosted**
passport has limits in the APort dashboard; `doctor` reports the configured
identity but cannot inspect or change those limits. Configure and verify the
hosted read/write policies separately rather than treating a local check as proof
of hosted enforcement.

## What a session is told it may not do

The sandbox and the ruleset stop what they can see. Three things they cannot see are covered by the rules every prompt carries (`lib/prompt.mjs`), which means they are asked for rather than enforced, and the run log is where you check they were honoured.

- **No merge, no default branch, no new PRs, no force-push, no rebase.** Keeping the branch on its base is the daemon's job, done with a merge commit, so a rebase is not help; it rewrites commits a reviewer has already commented on.
- **No `git stash`, in any form.** This one is not about the branch. The stash stack belongs to the repository, not to a worktree: every worktree of the same clone shares one stack. So a `stash pop` in a run can drop another worktree's entry into its tree, and a `stash push -u` sweeps up untracked files nobody meant to move. The quiet failure is a session that stashes and is then killed or runs out of budget before popping, which leaves your tree changed with nothing in the run's state saying so. A real run did this twice, to find out whether a test failure was pre-existing. That is a fair question, so the rule names the answers that do not touch shared state: a second tree with `git worktree add <temp path> <base>`, or one file at the base with `git show <base>:<path>`.
- **No harness attribution.** No `Co-Authored-By:` trailer naming a model or its vendor, and no "Generated with" or robot-emoji line, in a commit message or a PR body. This is the one rule in this list that is also enforced: a `commit-msg` hook refuses the commit, so a session that forgets finds out at once rather than on a public pull request, which is where a live run's four commits carried `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Naming a harness in prose is allowed, because a change that is genuinely about an adapter has to be describable. The PR body half is not enforceable locally and is asked for in the prompt; see below.
- **A denial is a boundary, not an obstacle.** A reviewer or guardrail refusal means stop and report, not re-spell the command, move it into a script, or find another path to the same effect. A sandbox permission error may use the harness's supported approval request first; that is how authorized Codex Git writes proceed. A real run hit a blocked-pattern rule on the literal names of two environment variables set inline, wrote a shell script that set the same variables, and ran it five times. The prompt forbids that route around a policy denial and asks for the reason in the final message.

## Who commits, and what the message may say

A run commits **as you**. `user.name` and `user.email` are resolved per run from your own git config and passed on git's
command line, where nothing in a repository can override them. There is no bot identity and no flag to ask for one: you
wrote the brief and you are shipping the work, and the harness is a tool in the way an editor is. A `gallivant` committer
would tell your reviewers a robot did it, which is both wrong about who is responsible and the thing that gets a pull
request discounted in review.

The values cannot simply be read by the run. Your identity is in `~/.gitconfig`, and `GIT_CONFIG_NOSYSTEM=1` plus
`GIT_CONFIG_GLOBAL=/dev/null` drop exactly that file, deliberately: a sandboxed session cannot read outside its worktree,
and a run pointed back at `~/.gitconfig` fails every git command, `git status` included, on a file it is denied. So the
daemon reads the identity where there is no sandbox and passes the values through. No file outside the worktree is named
and the sandbox stays as strict as it was.

With no identity configured, `gallivant start` and `gallivant resume` refuse before anything is spawned:

```
error: no git identity on this machine. Gallivant commits as you, so it needs one.
  git config --global user.name  "Your Name"
  git config --global user.email "you@example.com"
```

Early, for the reason the base-branch check is early: no money on a session that cannot commit what it writes.

The message body is a separate problem with a separate mechanism. Harnesses add their own `Co-Authored-By:` trailer, and
a live pull request carried one on all four of its commits. That is a **hook**, not a line in the prompt, because a
prompt is a request a session can forget and forgetting it is exactly how those commits happened. `commit-msg` in each
checkout's `.git/hooks` matches the trailer and the "Generated with" line, prints which line is the problem and what to
do, and exits non-zero, so git creates no commit object at all. The same hook covers local CLI commits because it fires on whatever process
runs `git commit`; coordinator publication validates hosted output separately.

`.git/hooks` rather than a directory inside the checkout. A relative `core.hooksPath` would also work and would keep the
run env free of absolute paths, but it puts a directory in the working tree, where it shows up as untracked in
`git status`, in the `git diff --check` briefs run, and in the uncommitted-work count a timeout kill reports. A guard
that makes a clean tree look dirty is one the first session wanting a clean `git status` would trade away. `.git/hooks` is
git's own default, needs no config, sits outside the working tree, and dies with the clone.

The Git hook does not intercept `gh pr create`. Public-output validation is a
separate control: coordinator GitHub writes validate public text, hosted artifacts
are checked before publication, and the review loop checks existing PR text before
readiness. A local agent's direct GitHub call can therefore create text that later
needs correction; the prompt alone is not a pre-write boundary on that call.
Neutral status labels and encoded recovery metadata preserve tracking without
promotional attribution. See [public output](commands.md#public-formatting-and-compatibility).

## Reading a denial

`gallivant why` prints each denied call with the guardrail's own reason on the line beneath it, and the APort audit lines for the run's window below that. You need both, because neither half is complete:

```
permission denials (the call, and the guardrail's reason where the run recorded it):
  - Bash: {"command":"grep -n \"productPages\" web/src/lib/products.config.ts"}
    APort denied this tool call. Policy: bash. Reason: oap.blocked_pattern. Detail: Command contains dangerous pattern: Access to sensitive configuration files.
```

The audit line for that decision names the pattern and carries no path. The denial list names the path and carries no pattern. Paired, they say what the audit line alone could not: the pattern is broad enough to catch a `grep` of a project source file whose name ends `.config.ts`. That is a block working as written and still worth changing, which is a judgement only an operator can make and only from both halves. Both come out of the run's own log, joined on the tool-call id they share, so nothing extra is recorded to get this.

## Codex

The current setup guide and `doctor` recommend warn mode for the Codex hook based
on recorded unsupported multi-file `apply_patch` and listing-tool behavior.
Warn mode can downgrade policy denials, but adapter failures may still block calls
before policy evaluation. Verify the installed guardrail version and actual audit
records before changing enforcement. Local sandbox permissions, reviewed escalation,
token scope and GitHub rules remain separate controls; a hook warning is not proof
that a tool call was denied. The historical findings are linked below.

## Known limits

- The coordinator runs as its OS user on macOS or Linux. Sandboxes, token scope and repository rules constrain worker actions; they do not isolate an arbitrary same-user process from all coordinator state. A dedicated OS user can narrow that host exposure.
- Codex `network_access=true` removes the network boundary inside the checkout. Accepted on day one; the token scope and the ruleset bound what a push can do.
- `context_paths` widens what a run can read and therefore what an injected run can leak. The refusals above stop the worst of it; the narrowness of the paths you choose is the rest.
- Logs may contain sensitive tool inputs. Private provider diagnostics are separate from the redacted projections served by the tracker, but redaction is not a guarantee that all sensitive application data is removed. Protect the Gallivant home and tracker access. Do not delete active run directories: ownership journals, acceptance records and evidence are required for safe recovery. Back up matching state before retention cleanup or migration; see [execution storage](execution.md#journal-projections-and-retention).

## Follow-ups filed against APort

The historical [decision record](https://github.com/uchibeke/gallivant/blob/main/docs/audit/DECISIONS.md) lists: multi-file `apply_patch` in the Codex hook, `git push` refspec parsing, control-plane paths blocked by default, a non-interactive local passport install, and a Repository Guard slice that blocks pushes rather than reporting merges.
