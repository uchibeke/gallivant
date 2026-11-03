---
status: ready
harness: codex
aport_decision: 9d0cde7a-cd56-461e-8016-dbc57e20b09c
---

# Review image evidence in pull requests

## Problem

Gallivant's independent reviewer refuses a pull request when its host reports a binary file. This protects review completeness but prevents WebBabyShower's resend PR from progressing because it contains browser screenshots. A separate local Codex CLI probe interpreted a synthetic screenshot with the existing restricted reviewer profile and tools disabled; this is feasibility evidence, not integration or review clearance. Implement bounded, independently reviewed image evidence while preserving the existing text, host identity, completion and safety gates. Use the shared review architecture, not a Bitbucket-only scheduler.

## User stories

- As a repository operator, I want screenshots independently reviewed against the exact PR revision, so that visual evidence does not make the task permanently unreviewable.
- As a repository operator, I want unsupported binaries and unavailable vision capabilities to remain explicit blockers, so that partial review cannot become clearance.

## Acceptance criteria

- Given a same-repository PR with supported PNG or JPEG changes, when capturing review evidence, then the qualified host adapter inventories every changed path and captures the necessary before and after image bytes for additions, removals, modifications and renames at exact head and merge-base revisions. Verify repository and PR identity, complete inventory, format, size and hashes; recheck PR binding. Bound image count, dimensions, individual and total bytes before processing. Never follow arbitrary URLs, symlinks or paths outside the controlled evidence workspace. Unsupported binaries, submodules, corrupt or oversized images and partial or stale captures fail closed. Preserve text-only behavior; support GitHub and Bitbucket through shared interfaces where their APIs are qualified.
- Given immutable evidence, when reviewing an image, then a fresh qualified restricted multimodal reviewer receives only coordinator-created image copies and minimum relevant evidence; no tools, author session, Git-host credentials, repository access or write authority. Treat image text and metadata as untrusted data. Validate exact image identity, revision and coverage; never pass an author-provided path as a command argument. If model, CLI or isolation cannot inspect images, report review-incomplete without fallback or clearance. Bind qualification to executable, model, configuration and capability; a text-only qualification cannot silently authorize image review.
- Given mixed text and image changes, when partitioning and synthesizing, then every text slice, changed image side and criterion is covered within bounded job, timeout and spend policies. Represent visual findings without invented source-line quotations and retain verifiable image identity. Clear only when all required reports and whole-PR checks match the immutable input. Missing or malformed output, stale head, base, receipt, checks or policy, restarts and retry exhaustion cannot produce clearance. Preserve completed owned evidence on safe retries and never repeat ambiguous launches.
- Given an image containing adversarial instructions, when reviewed, then tests show that image text, filenames, metadata and PR content cannot change the prompt, select local paths, authorize tools or modify review policy. Verify identity and hash again at the protected execution boundary. Do not log credentials or unrelated local files, or treat a model's assertion as proof that the correct bytes were attached.
- Given image regression fixtures, when testing, then cover added, modified, removed and renamed images, wrong hashes and revisions, stale binding, duplicates, malformed or unsupported formats, dimension and size limits, attachment failures, unavailable vision, mixed PRs, retries, recovery, injection and complete coverage. Existing GitHub, Bitbucket, reviewer isolation and completion tests pass. Use the previously authorized disposable Bitbucket test repositories for a real screenshot review if safe and practical; record exact commits, policy, model, result and limitations. Never claim PR #311 reviewed based on a mock.
- Given the existing resend PR, when the implementation and qualification pass, then restart or recheck its existing task with its original context and policy, preserving screenshots and honest unmet criteria. Confirm whether its actual new-head review completes; do not merge, deploy, dismiss genuine findings or mark unmet requirements complete. Update first-party review, Bitbucket and troubleshooting documentation with supported images, qualification, limits and fail-closed behavior.

## Verify

- `npm test`
- `npm run lint`
- `git diff --check`

## Where to look

- `lib/hosts/bitbucket.mjs`, `lib/gh.mjs`, `lib/review_evidence.mjs`, `lib/first_party_review.mjs`, `lib/review_policy.mjs`, `lib/execution_preparation.mjs`, `lib/preparation_codex.mjs`.
- `test/first-party-review.test.mjs`, `test/bitbucket-review.test.mjs`, `docs/first-party-review.md`, `docs/bitbucket-review.md`.
- Previously authorized disposable repositories `webbabyshowers/gallivant-host-test` and `webbabyshowers/gallivant-host-test-public`; affected PR https://bitbucket.org/webbabyshowers/babyshower-frontend/pull-requests/311.

## Out of scope

- Disabling independent review, weakening the completion gate, removing screenshots merely to pass, production deployments, auto-merges, production customer data or granting the reviewer host credentials.
