# Node runtime and harness shells

Gallivant's local implementation adapters prepend the directory containing the
Node executable that launched Gallivant to PATH. Start and resume share this
implementation. Executable discovery checks inherited PATH first, then the
operator's login shell with `command -v`, then `/bin/sh`. Linux does not require
zsh. Paths with spaces and apostrophes are shell-quoted.

Claude can rebuild PATH from a shell snapshot. Its SessionStart hook therefore
appends the runtime path to `CLAUDE_ENV_FILE`, which Claude applies to subsequent
Bash commands. This uses the documented
[session environment mechanism](https://code.claude.com/docs/en/hooks#persist-environment-variables).
The original settings and hooks are preserved; a private settings snapshot beside
the operator's settings file is used for each dispatch. Original settings are not
edited. Snapshot directories are named `runtime-*` and should only be removed
after their associated processes finish.

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

## Verification

`node --test test/runtime-environment.test.mjs` exercises actual shell execution
with a conflicting Node, all five local start/resume adapters, quoting, portable
discovery, and preservation of security settings. `npm test` includes this file
and all existing suites, including remote adapter tests. The runtime-portability
workflow runs the full suite on Ubuntu and macOS with Node 22 and 24.

`GALLIVANT_RUNTIME_LIVE=yes node test/runtime-environment-live.mjs` is an opt-in
Claude probe using configured authentication and guards. It allows one run with
a $2 ceiling and verifies actual Bash-tool output rather than assistant claims.
It does not install packages, access customer data or weaken security settings.
Native checks for other providers and Linux are separate from local fixture
coverage; a green fixture does not prove their credentials or model access.
