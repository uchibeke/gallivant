# Runtime portability verification

Revision tested: `85c0761`. This change is not yet qualified for rollout.

## Verified

- Actual Claude Bash selected the ARM64 Node executable that launched Gallivant,
  with the checkout-local npm cache. PATH alone previously selected x64 because
  the configured sandbox could not read the version-manager installation.
- Seven runtime regression tests pass, covering Claude, Codex, Gemini, OpenCode
  and Goose start/resume environments, shell quoting, executable discovery,
  preserved security settings, and tool-free preparation.
- Preparation and runtime suites together: 56 passed, zero failures.
- Removing the implementation's PATH export caused three assertions to fail:
  selected Node restoration, quoted PATH preservation, and Claude hook execution.
  Restoring it returned the seven-test suite to green.
- Syntax checks and `git diff --check` passed.

These adapter tests are not native model sessions for every harness. Only Claude
received a native tool-shell runtime probe in this change.

## Full-suite blockers

The local full run reported 1,308 passes and one failed test file after the
operator stopped `execution-backends.test.mjs` at approximately 410 seconds.
Its last completed case was private local cleanup; the following output-replay
case did not complete during that run. This is not a clean full-suite result.
The same case on unchanged main passed alone in 19 seconds, so a baseline
regression conclusion is not established by that reproduction.

Follow-up isolation runs on the fix passed: the output-replay case passed in
24 seconds, and all 182 remaining execution-backend cases passed in 192 seconds.
Together with the full run's other passing files, these exercise the local suite
without assertion failures in the reruns. They do not replace a clean single
full-suite run or explain the original concurrency-dependent stall.

[CI run](https://github.com/uchibeke/gallivant/actions/runs/37704427595) exercises
Ubuntu and macOS on Node 22 and 24. Both macOS jobs reported 1,250 passes,
93 failures and three skips. Ubuntu Node 24 reported 1,247 passes, 96 failures
and three skips. The new runtime checks passed in the inspected logs, but many
existing integration cases refused the host verification sandbox. Ubuntu also
reported merge-base fixture failures. Do not treat these as waived failures or
assume every failure has the same cause.

Before rollout, diagnose runner prerequisites, establish baseline comparisons,
and obtain a complete green run. Do not disable sandbox enforcement, bypass
existing guards, or silently exclude failing cases to achieve that result.

## Scope boundaries

No agent-passport implementation files changed. No dependency lockfiles were
rewritten to install a different architecture. No global Claude permissions
were removed. The runtime grant is read-only, retains existing denies, and
does not grant network destinations or general home-directory access.

Remote providers retain their remote environments. A native Linux tool-shell
session and native sessions for other local harnesses remain unverified.
