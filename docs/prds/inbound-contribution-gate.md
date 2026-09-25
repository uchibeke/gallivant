---
status: draft
harness: claude
---

# Deliverable gate for inbound contributions

## Problem

Gallivant gates only the work it starts. The daemon lists its own pull requests and skips any branch that is not
`gallivant/*`, so a contribution opened by a person, or by somebody else's agent, never meets the PRD contract. That
leaves the maintainer's actual problem untouched. A public repository receives pull requests that claim to fix an
issue, and reading them to find out whether they do is the expensive part. The maintainer pays that cost on every
drive-by contribution, and agent-written contributions make the volume worse without making the claims more reliable.
The enforcement point that every contributor passes through is continuous integration, not a tool on one maintainer's
laptop.

## User stories

- As a repository maintainer, I want a pull request that claims to close an issue to carry an attestation against
  that issue's acceptance criteria, so that I can see what the author claims before I read the diff.
- As a repository maintainer, I want the check to name the specific criterion that lacks evidence, so that the author
  can fix the claim without me writing the review comment myself.
- As a contributor, I want the check to tell me exactly what is missing when it fails, so that I can satisfy it
  without guessing at an unwritten standard.
- As a maintainer of several repositories, I want the same policy pack to decide every repository, so that one change
  to the standard applies everywhere rather than drifting per repository.

## Acceptance criteria

- Given a pull request whose body links an issue that carries acceptance criteria, when the check runs, then it
  evaluates the pull request body against `deliverable.task.complete.v1` and reports one result per criterion.
- Given a pull request that attests a criterion with no evidence, when the check runs, then it fails and the summary
  names that criterion and the missing evidence.
- Given a pull request that links no issue, when the check runs, then it neither fails nor claims to have verified
  anything, and the summary says the check did not apply.
- Given a repository that has not enabled the check, when a pull request arrives, then nothing about the existing
  workflow changes.
- Given an attestation whose evidence names a file, when the check runs, then it confirms that file appears in the
  pull request diff and fails the criterion when it does not.

## Verify

```sh
npm test
```

- `node --test test/*.test.mjs`

## Where to look

- `integrations/github/actions/policy-verify/` in the agent-passport repository, which already runs on inbound pull
  requests and computes `files_changed`, `lines_added` and `structural_findings`
- `policies/deliverable.task.complete.v1/` for the policy pack and its deny codes
- `lib/deliverable.mjs` in this repository, for the receipt shape and the evidence rules already proven here

## Out of scope

- Any change to Gallivant's own daemon, its PRD contract or its completion gate.
- Blocking a merge. The check reports; a human still decides, as the repository guard does today.
- Judging whether an implementation is correct. This gate checks that a claim exists and its evidence points at
  something real, which is a different question from whether the code works.
- Persona review of inbound contributions, which needs its own brief.
