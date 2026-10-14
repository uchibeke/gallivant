# Contributing

Use macOS or Linux with Node 22 or 24. Install dependencies with
`npm ci --ignore-scripts`. Run `npm run lint`, `npm test` and `npm run test:install`
before opening a pull request. Native isolation tests need Command Line Tools on
macOS or Bubblewrap with user namespaces allowed on Linux; see
`.github/workflows/runtime-portability.yml` for the tested host setup.

`npm test` uses fixtures and disposable repositories. Live harness suites are
separate opt-in commands: they need authenticated provider access and can spend
credits. Do not include credentials, private run logs, local config or customer
content in a contribution. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.

Keep orchestration in shared services so CLI, daemon and UI use the same rules.
Preserve same-session recovery, bounded retries, ownership checks, sandbox
refusals and human merge gates. Add focused regressions for correctness fixes,
and update the relevant command/configuration documentation when behavior changes.

Describe the user-visible problem, the resulting behavior and the checks you ran.
An implemented adapter is not a live-qualified provider; record that distinction.
