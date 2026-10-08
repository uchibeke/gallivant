# Runtime portability verification

## Review fixes

Both review findings were reproduced and addressed: executable lookup now supplies
an absolute fallback PATH on Linux, and speculative `buildRun()` calls no longer
create settings files. The runner owns each actual snapshot and cleans it after
confirmed process exit, failed launch or recovered settlement. Unknown process
ownership retains the file. Snapshot creation inside a checkout, including through
a symlink, is refused.

The wording now distinguishes the previously fixed coordinator verification shell
and exact harness executable from this fix for Node inside harness tool shells.
Native package selection depends on the Node process, not hardware alone.

## Current verification

- 92 focused tests passed, including shell restoration, all five local adapters on
  start/resume, quoting, empty/missing PATH, preservation of guards, tool-free
  preparation, actual snapshot cleanup, launch failures and restart recovery.
- A native Claude Bash probe passed on macOS ARM64 / Node 22.22.0 with existing
  guards and a $2 ceiling. It selected the launching Node and checkout-local npm
  cache. No owned settings file remained after exit. Sanitized evidence is in
  [runtime-portability-native.json](runtime-portability-native.json).
- The real macOS verification sandbox preflight passed with network disabled and
  filesystem access bounded to the checkout and trusted runtime.
- A full local run passed 1,349 of 1,350 checks. Its sole failure was the live-test
  helper passing an extra undefined option; that was corrected and its focused
  tests passed. A final full-suite rerun and the CI matrix are pending.

## CI prerequisites

Earlier CI runs failed native verification isolation on both platforms; Linux
also exposed two merge fixtures lacking an explicit Git identity and the empty
PATH regression. The fixtures now supply a synthetic identity. The workflow
installs Bubblewrap on Linux and selects macOS Command Line Tools. A native
preflight prints the actual synthetic sandbox-probe failure before the suite,
so missing isolation is diagnosed directly. Enforcement remains required: no
checks are skipped and no sandbox fallback is enabled.

The matrix covers Ubuntu/macOS with Node 22/24. Its final result must be checked
before merging; local success alone does not qualify both operating systems.

## Scope boundaries

No agent-passport implementation files changed. No dependency lockfiles were
rewritten to install a different architecture. No global Claude permissions
were removed. The runtime grant is read-only, retains existing denies, and
does not grant network destinations or general home-directory access.

Remote providers retain their remote environments. A native Linux tool-shell
session and native sessions for other local harnesses remain unverified.
