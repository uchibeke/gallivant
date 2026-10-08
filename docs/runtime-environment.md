# Node runtime and harness shells

## Why this is needed

A harness executable and the Node used by its Bash tools are separate choices.
Earlier fixes made coordinator verification use a non-login POSIX shell and
named the exact configured harness executable in each session. Neither prevented
Claude's saved shell environment from selecting another Node installation.
On an ARM64 Mac, that selected an x64 Node under Rosetta while the checkout had
ARM64 native dependencies; sandbox reads also blocked the intended Node under
the operator's version-manager directory.

Native dependencies must match the Node process that installs and executes them,
including its platform, architecture and supported ABI. Hardware architecture or
a lockfile alone does not establish that match. Do not copy an alternative Rollup
binary into `node_modules` or change the lockfile to hide a mismatched interpreter.

## Shared runtime contract

Gallivant's local implementation adapters prepend the directory containing the
Node executable that launched Gallivant to PATH. Start and resume share this
implementation. Executable discovery checks inherited PATH first, then the
operator's login shell with `command -v`, then `/bin/sh`. Missing or empty PATH
gets `/usr/bin:/bin` for the fallback lookup. Relative PATH entries do not grant
executable discovery from the checkout. Linux does not require zsh. Paths with
spaces and apostrophes are shell-quoted.

Claude can rebuild PATH from a shell snapshot. Its SessionStart hook therefore
appends the runtime path to `CLAUDE_ENV_FILE`, which Claude applies to subsequent
Bash commands. This uses the documented
[session environment mechanism](https://code.claude.com/docs/en/hooks#persist-environment-variables).
The original settings and hooks are preserved. Building or rebuilding a launch
description creates no files. At actual dispatch the runner exclusively creates
`runtime-settings.json` (0600) in its private run directory (0700), outside the
agent checkout. Original settings are not edited. Exit and failed-launch handling
remove owned snapshots; coordinator observation, settlement and the next launch
also recover cleanup after a restart. Unknown process ownership or surviving tool
processes retain the file until absence is confirmed. Tool-free preparation never
receives this settings overlay or its hooks.

PATH alone is insufficient when `blockReadsOutsideWorkingDirectories` prevents
the shell from reaching a version-manager installation. The snapshot adds
[sandbox read allowances](https://code.claude.com/docs/en/sandboxing) for the exact
running Node executable and recognized npm, pnpm and Corepack package roots
resolved from sibling executables. It does not grant writes, permit network
destinations, expose the home directory, change model selection, or turn off
APort hooks. Existing denies remain in the settings. Administrators can still
prevent runtime access through managed policy; that requires operator correction,
not disabling the sandbox or replacing dependencies with another architecture.

Package-manager code is executable, operator-trusted tooling. Install Gallivant
using the Node version intended for its work, not a project-controlled Node
binary. Restart the daemon after changing installations. Repositories requiring
a different Node version must explicitly provision that toolchain; this change
does not infer one from untrusted repository files or run a version manager.

npm's upper- and lower-case cache variables point to
`node_modules/.cache/gallivant/npm` inside the checkout. The existing npm user
config isolation is retained. This does not grant access to home caches or copy
registry tokens. A custom package manager or native runtime with additional
libraries can still need operator-approved paths. Other harnesses receive the
same initial PATH/cache contract but retain their own native shell behavior.
Remote/cloud adapters run on another machine and are not assigned local paths.

## Diagnosing a mismatch

Run this in the affected harness's tool shell before installing dependencies:

```sh
command -v node npm npx pnpm
node -p 'JSON.stringify({execPath:process.execPath,platform:process.platform,arch:process.arch,version:process.version,abi:process.versions.modules,cache:process.env.npm_config_cache})'
```

Compare the result with the selected runtime printed by the session hook. If it
differs or a read is denied, preserve the error and fix the host runtime/access
configuration first. Once the intended interpreter is accessible and selected,
use the repository's documented locked install to rebuild any dependencies left
by a different interpreter. This change does not repair existing `node_modules`
automatically. Already-running sessions retain their launch environment; after
installing the fix, restart the daemon and resume the same task through the normal
controls so the next session invocation receives the new setup.

## Verification

`node --test test/runtime-environment.test.mjs` exercises actual shell execution
with a conflicting Node, all five local start/resume adapters, quoting, portable
discovery, preservation of security settings, actual child-process cleanup,
failed launches, restart recovery, and refusal of agent-writable snapshots.
`npm test` includes this file
and all existing suites, including remote adapter tests. The runtime-portability
workflow runs the full suite on Ubuntu and macOS with Node 22 and 24. CI installs
Bubblewrap and activates Ubuntu's packaged sandbox-helper AppArmor profile on
Linux, and selects Command Line Tools on macOS before running
`node test/verification-host.mjs`. This preflight must prove the real filesystem
and network boundary; failing isolation never becomes an unsandboxed fallback.

`GALLIVANT_RUNTIME_LIVE=yes node test/runtime-environment-live.mjs` is an opt-in
Claude probe using configured authentication and guards. It allows one run with
a $2 ceiling and verifies actual Bash-tool output rather than assistant claims.
It does not install packages, access customer data or weaken security settings.
Native checks for other providers and Linux are separate from local fixture
coverage; a green fixture does not prove their credentials or model access.
