# PR #2 branch review — 2026-09-28

Reviewed [PR #2](https://github.com/uchibeke/gallivant/pull/2), starting at
`9290c028e81fabe9548cf738466e0bdf0ec24d3b`, against `origin/main`
(`4719d7eb1e5591fcff933b18a1506056bbea4770`). Scope included the changed runtime,
CLI, tracker, tests and documentation, plus the current entrypoint, package
contents, process lifecycle, filesystem boundaries, credentials, session
ownership, event handling, snapshot consistency and duplicated rules.

## Critical security finding

An obfuscated remote-code loader was appended after the CLI's legitimate main
dispatcher, hidden behind whitespace on the same line. A `createRequire`
bootstrap at the top of the entrypoint supported it. Both were removed.

Static decoding showed that it disabled console methods, queried Ethereum RPC
for transaction data, decoded a server address, fetched `/boot` and `/0/boot`,
then executed downloaded JavaScript through `eval` and detached Node processes.
The fetched code was not retrieved or executed during this review. RPC providers
appearing in the loader are not themselves established as malicious.

Evidence fingerprints:

| Evidence | SHA-256 |
| --- | --- |
| Removed payload | `21d8f5627912efb0e8ad728d5cb393bf70218e89fa822583c22823dc76b31816` |
| Original CLI file | `85d80deb3497aa7ce00d7bb7bcbf133d9e4381bb705f4e9b063c2b716accdb74` |

The original bytes and static decoding are preserved locally at
`/private/tmp/gallivant-pr2-security/`, outside the package and repository. The
loader existed in both the original PR head and `origin/main`; reviewing only
the PR diff would not reveal it. No other tracked executable loader was found in
the static scan. This does not establish the provenance or safety of repository
history, earlier installations or any previously executed remote payload.

The baseline tests did not execute the CLI entrypoint. The new CLI smoke test
was run after removal, with a static regression check for the removed loader's
entrypoint mechanisms. This is a targeted regression guard, not a general
malware detector. Pushing this branch does not clean `main`, old published
packages, running processes, or machines where an affected CLI was used. Those
require a separate exposure review; credentials accessible during an affected
execution should be treated as potentially exposed.

## Codex feedback dispositions

All 15 review comments present at the final refresh were evaluated.

| Comment | Disposition |
| --- | --- |
| [Procfs test hang](https://github.com/uchibeke/gallivant/pull/2#discussion_r4113932150) | Fixed: a regular file used as a parent deterministically produces `ENOTDIR`, without procfs or permission assumptions. |
| [Slow startup probe](https://github.com/uchibeke/gallivant/pull/2#discussion_r4113932151) | Fixed: ownership is published before awaiting GitHub; background timeout cancels an unreported child. |
| [Exclusion after health-write failure](https://github.com/uchibeke/gallivant/pull/2#discussion_r4113932152) | Fixed: exclusive ownership uses a separate lock; failure to publish ownership aborts startup. |
| [Merge identity](https://github.com/uchibeke/gallivant/pull/2#discussion_r4117636365) | Already fixed at the reviewed head: context supplies identity to daemon Git operations. Existing regression checks pass. |
| [Missing identity stop](https://github.com/uchibeke/gallivant/pull/2#discussion_r4117636371) | Already fixed at the reviewed head: `NO_IDENTITY` becomes a durable needs-human stop. |
| [Resnapshot before merge](https://github.com/uchibeke/gallivant/pull/2#discussion_r4117636377) | Merge-before-resnapshot ordering already fixed; additionally preserved pending notices and restored copies across later failures. |
| [Deleted package files](https://github.com/uchibeke/gallivant/pull/2#discussion_r4117829626) | Does not apply to the current tree: package, entrypoint, libraries, templates and tests are present. Package dry-run succeeds. |
| [Ready-label removal](https://github.com/uchibeke/gallivant/pull/2#discussion_r4118176134) | Fixed: resume shares the tick's reopen operation and refuses to spawn if label removal fails. |
| [Unsettled completed run](https://github.com/uchibeke/gallivant/pull/2#discussion_r4118176137) | Fixed: an outstanding run record prevents resume even after its process exits. |
| [Reused daemon PID](https://github.com/uchibeke/gallivant/pull/2#discussion_r4118176141) | Fixed: ownership and shutdown verify recorded process start time and command. |
| [Hook symlink overwrite](https://github.com/uchibeke/gallivant/pull/2#discussion_r4118176145) | Fixed: component checks reject links and hooks are installed through atomic file replacement. Hard-link targets are preserved. |
| [Token-authenticated clone protocol](https://github.com/uchibeke/gallivant/pull/2#discussion_r4127834407) | Fixed: clones explicitly use HTTPS; supported GitHub SSH origins are normalized before existing checkouts run or merge. |
| [Escaping source symlinks](https://github.com/uchibeke/gallivant/pull/2#discussion_r4127834411) | Fixed: carried files reject symlinks at every path component, traversal and `.git` paths, on reads and writes. |
| [Carried-file divergence](https://github.com/uchibeke/gallivant/pull/2#discussion_r4127834412) | Fixed: resume checks bytes as well as the manifest; explicit acceptance updates snapshots, checkout copies and prompts. Readiness/status share the comparison. |
| [Harness change on resnapshot](https://github.com/uchibeke/gallivant/pull/2#discussion_r4127834415) | Fixed: resnapshot cannot transfer an existing session to a different harness. |

## Additional correctness and DRY fixes

- Registering a branch outside `gallivant/*` referenced a missing `toPrdId`
  import. The fallback now works.
- Changing a registration's harness drops inherited sessions even when both
  harnesses use UUIDs. Identifier shape is not session ownership.
- Reviewer messages containing blocking findings now block readiness, including
  findings in a review or issue-comment body rather than only inline comments.
- Start and no-PR resume prompts no longer contradict themselves about opening
  a PR. Resume uses the recorded base/head when opening one.
- Hook generation uses the same attribution patterns and matcher as runtime
  checks. Repository file operations, daemon ownership, brief comparison,
  source restoration and ready-label reopening have shared implementations.
- Source snapshot writes precede acceptance of a changed manifest. Failed
  resnapshots preserve notices for retries; recreated checkouts recover carried
  snapshots. Stale-lock recovery is serialized.
- The additional agent's `ready --check` feedback was justified: validation now
  skips runtime config entirely. A CLI regression covers malformed config and
  verifies no writes. Hosted readiness prints progress; its existing fetch
  timeout remains 15 seconds.
- Documentation now describes session ownership, source restrictions, daemon
  identity and resnapshot behavior, and removes duplicated start steps.

## Validation

- Baseline: 510 tests passed on Node v22.22.0/macOS.
- Final: **537 tests passed**, zero failures, skips or cancellations.
- `npm run lint` passed (syntax checks).
- `git diff --check` passed.
- `npm pack --dry-run --json --cache /private/tmp/gallivant-npm-cache` passed:
  58 package entries, including both new runtime modules; no tests, local
  decoding evidence or dependencies bundled.
- Regression coverage includes symlink/hard-link safety, HTTPS selection,
  snapshot acceptance and retry failures, ready-label failures, unsettled runs,
  stale PID refusal, missing/failed health reporting, startup publication,
  background spawn errors/timeouts and CLI check isolation.

Daemon tests require `ps`, which is denied in the Codex sandbox; the complete
suite passed with process inspection permitted. The user's other agent also
reported successful real `up --once`, `up`, `status` and `down` checks outside
the sandbox; those are separately reported observations, not additional live
daemon tests performed in this review. No paid harness sessions or remote
GitHub mutations were used for validation.

## Remaining boundaries

Filesystem guards prevent static symlink/hard-link overwrites; they are not an
OS isolation boundary against an adversary concurrently renaming ancestor
directories. Harness sandboxing remains necessary. An interrupted lock write
or stale-recovery crash can leave an incomplete lock/recovery marker and fails
closed; verify that no owner remains before removing such a marker. Legacy
daemon records lacking identity cannot authorize a signal or safe duplicate
startup. Other Node versions/platforms were not exercised locally.
