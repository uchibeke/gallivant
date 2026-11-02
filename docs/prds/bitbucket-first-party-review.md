---
status: ready
harness: codex
aport_decision: 6d8343b5-b07a-4381-939a-ba4d569b5b89
---

# Qualify independent local review for Bitbucket Cloud PRs

## Problem

Gallivant's first-party reviewer is a separate, restricted Codex execution after a PR is opened. It requires complete, exact-revision host evidence. GitHub supplies that evidence; Bitbucket Cloud currently does not, so live Bitbucket runs use an explicit legacy no-review policy. A separate Bitbucket reviewer account is not available for this installation. The authorized WebBabyShower runs have already started and their PRD snapshots must remain unchanged. Implement the host evidence and bounded review path before changing their review policies.

## User stories

- As a Bitbucket repository owner, I want Gallivant's independent local reviewer to inspect every changed file and every acceptance criterion, so that the implementer cannot clear its own PR.
- As an operator, I want a large PR to receive a bounded complete review or an actionable refusal, so that a size limit never becomes an unreviewed pass.
- As a task operator with existing Bitbucket runs, I want to switch their review policy through the audited command and recheck the same PR, so that the run and fix context remain intact.

## Acceptance criteria

- Given an open same-repository Bitbucket PR, when first-party review captures evidence, then the Bitbucket adapter proves repository UUID, PR number, exact full head and base object IDs, merge base, complete paginated changed-path inventory, complete diff and before/after text for added, modified, removed and renamed files. It compares the host's changed-path inventory with the diff and refuses binary, submodule, missing-patch, duplicate, truncated, stale, rate-limited or oversized evidence. It rechecks the PR binding after capture. Use Bitbucket's documented commit comparison, diffstat, source and merge-base APIs through the existing credential and host boundary; do not follow arbitrary redirects or leak the API token.
- Given a review whose complete evidence exceeds the current 100,000-byte single-job input cap, when reviewing, then the shared first-party service partitions evidence into bounded, immutable pieces and runs fresh restricted reviewer jobs with no author session, tools, network credential or publication authority. Every changed path and every criterion must be covered; the aggregate is clear only if every required piece is clear and all identities match the same head/base/body/checks/policy. Any missing piece, timeout, malformed response, unresolved scope or finding blocks readiness. A single large changed file, including a lockfile, must be covered in bounded pieces or refused explicitly; never silently omit it or increase the limit without an enforced total cost/job bound. Reuse this mechanism for GitHub and future hosts rather than adding a Bitbucket-only review loop.
- Given review findings, when Gallivant resumes the implementer, then the existing fix-round mechanism receives all verified findings once with exact file/line evidence, and a changed head invalidates every earlier piece and aggregate. Restart, repeated host pages, recheck and policy changes cannot turn a partial or old-head review into clearance.
- Given a Bitbucket repository with no external reviewer account, when `review.route: codex` and `review.mode: first-party-required` are configured and the route passes live qualification, then a new run and an existing run changed through `gallivant review policy ... --mode first-party-required --reason ...` both use the separate local reviewer. The coding session's Git/Bitbucket credential is unavailable to the reviewer. `legacy_no_review` is removed only through the explicit policy-change path; the original PRD snapshot, run identity, PR and agent session remain intact. A review route that cannot qualify refuses before a paid dispatch or policy change.
- Given the existing WebBabyShower backend PR is roughly 340 KB of diff, when testing the bounded review design with a comparable deterministic fixture, then it either covers the entire change within configured job/cost bounds or gives a clear `review-incomplete` reason. Do not claim this particular PR was reviewed until its actual full-head live review finishes. Zero CI checks remain an explicit separate policy, never an implicit reviewer waiver.
- Given the private and public disposable Bitbucket test repositories, when live qualification runs, then a real Codex first-party reviewer produces an exact-head blocking finding, the same PR is corrected, and a fresh clear verdict is recorded; verify credential isolation, no duplicate review after restart, and no clearance on a changed head. Record test repo/PR links, run IDs, reviewed SHA, selected model access and costs without secrets. Do not post synthetic model verdicts as evidence of a live review.
- Given GitHub and Bitbucket installations, when this change ships, then GitHub's existing reviewer behavior, completion gate, chain merge gate, host credential isolation and no-review disclosures still pass. Update README, Bitbucket setup, review, commands, troubleshooting and qualification docs to show the independent local reviewer path, its limits and exact activation commands. Do not claim other Git hosts are supported.

## Verify

- `npm test`
- `npm run lint`
- `git diff --check`

## Implementation boundaries

Build on the Bitbucket dispatch-enabled branch `fix/bitbucket-dispatch-no-review`. Use its host adapter and the existing shared first-party review service; no second daemon, separate Bitbucket reviewer account, automatic merge, deployment or alteration of active WebBabyShower briefs. Preserve the explicit human merge gate. Do not change the operator's local review policies or claim current PRs reviewed as part of implementation; activation is a separate operator step after the code and live qualification pass.

## Out of scope

- Changing the active WebBabyShower PRDs, merging their PRs, deploying their services or granting new host credentials.
- Adding an external Bitbucket reviewer account, a second scheduler or support for another Git host.

## Where to look

- `lib/hosts/bitbucket.mjs`, `lib/gh.mjs`, `lib/review_evidence.mjs`, `lib/first_party_review.mjs`, `lib/review_policy.mjs`, `lib/commands/review.mjs`.
- `docs/prds/git-host-bitbucket.md`, `docs/bitbucket-review.md`, `docs/audit/bitbucket-review-qualification.md`, `test/first-party-review.test.mjs`, `test/bitbucket-review.test.mjs`.
