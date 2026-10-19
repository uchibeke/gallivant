# Releasing

The package name is `gallivant`; the executable is `gallivant`. The repository is
`uchibeke/gallivant`. The first public release is pending: the npm registry check
on 2026-10-18 returned 404, and the repository was private. Do not announce an
available npm install until publication and the consumer smoke check pass.

## One-time launch setup

1. Review all branches and Git history, author metadata, issues, PR discussions,
   Actions logs and artifacts for private material before changing visibility.
   Removing a file from the current checkout does not remove historical copies.
   Retain history unless a specific disclosure requires cleanup; coordinate any
   rewrite with open PRs and active runs that reference existing commits. After
   the owner accepts the reviewed exposure, make the repository public and enable
   GitHub private vulnerability reporting. These are owner actions, not effects
   of a PR merge.
2. Create a GitHub Actions environment named `npm`, restricted to release tags
   and `main`, with a required maintainer reviewer. Only release jobs receive
   publishing authority; pull-request tests get read-only permissions.
   Enable the `main` ruleset with pull requests, the four portability checks,
   and protection against deletion and force pushes. Read back both settings:
   merely referencing `environment: npm` in YAML does not create protection.
3. For a package that does not exist yet, arrange the initial npm publication
   credential with the npm owner. If needed, set a short-lived granular
   `NPM_TOKEN` in the protected `npm` environment, scoped as narrowly as npm
   permits. Never put it in the repository or a PR.
   A local `npm login` is not authentication for GitHub Actions. Do not publish
   the release locally to bypass this setup: the release's provenance is
   generated in supported CI, not by the developer's terminal.
4. Once the package exists, configure its npm trusted publisher for GitHub owner
   `uchibeke`, repository `gallivant`, workflow `release.yml`, environment `npm`.
   Permit direct `npm publish`, which is what this workflow runs. Validate a new
   trusted publisher within two days or recreate it after expiry; configure it
   shortly before the next planned release. An identical-version rerun skips
   publication and does not validate OIDC. Remove the
   bootstrap token after a successful OIDC release, then require 2FA and disallow
   traditional token publishing in the package settings. Trusted publishing
   needs npm 11.5.1+ and Node 22.14+; the workflow uses Node 24 and npm 11. See
   [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
   [provenance](https://docs.npmjs.com/generating-provenance-statements/).
5. Merge the reviewed release changes, verify CI, then publish. Repository
   visibility, npm ownership and environment protection must be checked in their
   respective settings; a workflow file alone does not configure them.

Read-only preflight (authenticated repository administration access is required
for environment and ruleset details):

```sh
gh repo view uchibeke/gallivant --json visibility,defaultBranchRef
gh api repos/uchibeke/gallivant/environments/npm
gh api repos/uchibeke/gallivant/environments/npm/deployment-branch-policies
gh api repos/uchibeke/gallivant/branches/main --jq '{protected,protection}'
gh api repos/uchibeke/gallivant/rulesets
npm whoami --registry=https://registry.npmjs.org
npm view gallivant version --registry=https://registry.npmjs.org
```

An absent package is expected before the first publication. An absent `npm`
environment or disabled branch protection is unfinished release setup.

### Staged publishing is a different workflow

npm now supports `npm stage publish` and explicit maintainer approval with 2FA.
It requires npm 11.15+ and Node 22.14+. Staging a new package creates a **public
`0.0.0-stage` placeholder**; it is not a dry run. The staged version's contents
remain private until approval. See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

This repository's release workflow publishes directly after the GitHub
environment approval. It does not stage, approve, or poll staged versions.
Do not configure its trusted publisher as stage-only or use staging as an
implicit bootstrap step. Adopting that route requires a separately reviewed
workflow that records the stage ID and waits for approval before creating the
GitHub release. Until then, use the documented CI bootstrap credential route.

## Release a version

Update the version with `npm version patch --no-git-tag-version` (or `minor`),
which updates `package.json` and `npm-shrinkwrap.json`. Include release notes in
the PR and merge it after CI passes. Do not bump the version for a retry.

The workflow follows the guardrails repository's pattern: validate the release
ref, test before publishing, and permit recovery without replacing published
versions. This single-package project does not need its multi-registry dispatcher.

Choose one trigger:

```sh
# From an up-to-date main checkout; replace the example with package.json's version.
git tag -a v0.2.0 -m 'Release 0.2.0'
git push origin v0.2.0

# Or dispatch against main; the workflow uses main's package version.
gh workflow run release.yml --repo uchibeke/gallivant --ref main
```

Every release runs the Node 22/24 × Linux/macOS matrix: lint, the offline test
suite, native isolation checks, and a clean installation of the actual tarball.
Publishing requires a public repository, an exact tag/version match (or manual
dispatch from `main`), and a commit reachable from `main`. An existing tag must
point to that exact commit. The protected environment gates publication.

The workflow packs the tested source, publishes to npm with provenance, then
creates a GitHub release with the tarball. No publish occurs on an ordinary PR
or version edit. A rerun accepts an existing npm version only when its SHA-512
integrity matches the freshly packed artifact. A registry error fails closed;
an existing version must also advertise provenance. Missing provenance is not
repaired by rerunning this workflow, and different bytes require a new version.
For an older tagged release, rerun its
original workflow rather than dispatching newer `main` with the old version.

## Verify before announcing

```sh
npm view gallivant version dist.integrity dist.attestations
npm install -g gallivant
gallivant --version
gallivant --help
```

Compare the registry's integrity with the workflow tarball and inspect the
attestation's source repository, commit and workflow. Run `npm audit signatures`
in a clean project that installed the released version to verify registry
signatures and available provenance. Metadata presence alone is not signature
verification; see [npm provenance verification](https://docs.npmjs.com/generating-provenance-statements/#verifying-provenance-attestations).

After publication is verified, update the README and installation guide to put
the tested npm install command first and remove the first-release-pending notes
(including this page). Keep the source-install alternative.

Use a clean test account/home and the [getting-started guide](install.md) for one
small real PR. Confirm implementation, feedback-driven continuation, CI and the
completion receipt; automated installation checks use fixtures and do not prove
paid-provider access. Recheck anonymous GitHub access and all README links.
Then change the README's primary installation command to `npm install -g gallivant`
and remove its pending-release note. Announcement drafts are in [launch.md](launch.md).

For local validation without publishing: `npm run lint`, `npm test`, and
`npm run test:install`. The last command packs and installs under a disposable
directory, exercises setup and PRD commands outside the source tree, and imports
every declared module export. It makes registry requests but no model calls.
