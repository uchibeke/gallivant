# Review on GitHub, deliver through Bitbucket

`npm run promote:bitbucket` transfers an accepted GitHub PR's **original commits** to Bitbucket Cloud and creates or updates its Bitbucket PR. It uses Git transport, the existing host adapters and the same review/check policy as the coordinator. It does not copy files, create commits, force-push, merge, enable CI or deploy.

This is an operator command from a Gallivant source checkout. Install dependencies with `npm ci`. Configure both hosts using the [Git host guide](git-hosts.md); Git push access and Bitbucket API repository/PR access are both required. The command uses the existing scoped credentials, including a configured Bitbucket SSH key. Never put a token in a repository URL or a plan file.

## Before promotion

- Register and finish the GitHub run. It must retain an exact accepted completion and review binding under an explicit review policy. A label, green CI or the PR author's statement alone is insufficient.
- Only the exact remotely reviewed commit is transferred. Local checkout edits, untracked carried research inputs, environment files and session logs are neither read nor included. The transfer uses its own disposable bare Git repository, so an operator checkout may remain dirty or may already have been removed after merge.
- Specify the destination repository explicitly. No organization or repository mapping is inferred.
- For an existing Bitbucket PR, supply its number. This updates that PR rather than creating a duplicate.
- The Bitbucket base must have the same Git tree as the reviewed GitHub base. Its commit hash may differ because the two hosts merged earlier changes separately. Promote dependent work in order, after the preceding Bitbucket change has merged. Reconcile differing trees on GitHub and obtain review again.
- An existing destination branch must be an ancestor of the reviewed source head. Divergence is not resolved automatically.

GitHub Actions may remain disabled for a review-only mirror. Zero CI checks are accepted **only** when the source run's operator-approved review policy explicitly allows zero checks. Configured required checks still must exist and pass. Local test results and production release requirements are not replaced by that setting. Missing required external or first-party review blocks promotion.

## Preview, approve and apply

For an existing mapped PR:

```sh
npm run promote:bitbucket -- \
  --github-pr https://github.com/example/app/pull/1 \
  --bitbucket-repo bitbucket.org/example/app \
  --bitbucket-pr 93 \
  --out accepted-promotion.json
```

The default is a remote read-only dry run. It fetches into a disposable temporary Git repository and prints the source and destination heads, bases, exact title/body, review policy, check count and a SHA-256 `digest`. `--out` saves that plan locally with mode 600 and refuses to overwrite an existing file. Keep private plans outside your repository; they can contain private PR prose. They contain no credentials or source session records.

Inspect the complete plan, then rerun the same mapping with its digest:

```sh
npm run promote:bitbucket -- \
  --github-pr https://github.com/example/app/pull/1 \
  --bitbucket-repo bitbucket.org/example/app \
  --bitbucket-pr 93 \
  --apply --expected-plan DIGEST_FROM_THE_DRY_RUN
```

The digest is an exact human approval pin, not a substitute for fresh review evidence. Changed source code, review, checks, public text, destination branch, base or existing PR text requires another dry run. Nothing reads or writes the run registry or starts another agent.

For a new PR, omit `--bitbucket-pr`. The default destination branch is `work/github-OWNER-REPO-pr-N`; `--branch` and `--base` select explicit alternatives. Subsequent runs reuse an existing PR only when its repository, branch/base and source-review provenance match. Otherwise supply an explicit PR mapping. Closed, cross-repository or duplicate targets are rejected.

The Bitbucket title and human-readable body come from the GitHub PR, with a source-review link and original commit SHA appended. Source task receipts and recovery/session metadata are removed because they do not authorize a new host/task. The source GitHub PR retains the complete evidence.

## After merging on GitHub

Run the same dry-run command after merge. When GitHub still supplies the original reviewed base, the coordinator's retained acceptance hash is checked directly against the original head, base, body, checks and policy. No pre-merge plan file is required. The accepted local record and fresh clear reviewer/check evidence remain mandatory; merging a PR before it was accepted does not manufacture that authority.

Optionally save `--out accepted-promotion.json` while the PR is accepted and still open. If GitHub later reports a different base, that archived plan can reconstruct the original base using:

```sh
--accepted-plan /absolute/path/to/accepted-promotion.json
```

Use the new printed digest for `--apply --expected-plan ...`, keeping `--accepted-plan` on that command too when using the fallback. The reconstructed binding must exactly match the coordinator's retained acceptance hash. The plan cannot replace a missing local acceptance record or authorize changed code, body, checks or policy.

The transferred head is the original reviewed PR head even when GitHub used squash or merge commits. The GitHub merge/squash commit is never described as reviewed or silently substituted. Squash merges can make subsequent branch histories diverge between hosts; prefer history-preserving merges for this bridge. A future branch that is not a fast-forward of its mapped Bitbucket branch must be reconciled and reviewed, not force-pushed.

## Races and retries

Apply rechecks the plan before pushing. A native pre-push guard checks the server-advertised old branch SHA; Git's ordinary fast-forward update then compares that SHA on the server. No force or force-with-lease option is used.

There is no atomic transaction across GitHub and Bitbucket. The command rechecks evidence and destination after the push, before publishing the PR, and verifies the returned PR head/base. The publication adapter's final reconciliation read also enforces the approved PR absence or exact existing number and previous title/body. An observed concurrent creation or text edit stops publication. This adapter has no atomic conditional-update contract with Bitbucket: an edit between that final read and the write can still be overwritten without detection, so avoid concurrent PR editing during apply. If an operation fails, including a lost push response, the branch or PR may already have been updated; the error states that possibility. Inspect the target and rerun a dry run. Never respond with a force push. Bitbucket merge and deployment remain separate operator decisions and retain their normal release controls.

This bridge supports GitHub to Bitbucket Cloud only. It does not automatically schedule promotion, accept unregistered PRs, establish live production readiness, or migrate CI/secrets/deployment configuration.
