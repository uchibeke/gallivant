# Requesting and verifying Codex reviews

A Git push updates the pull-request head and can start CI. It does **not** by
itself request a new Codex review. In this repository's observed setup, automatic
review covers a newly opened pull request; a later head needs an explicit
`@codex review` comment. Security review is a separate request using
`@codex security review`. A quiet thread after a push is therefore not a clean
review result.

Gallivant's background review loop posts the configured
`reviewer.rereview_comment` after a fix run it dispatched. A manual push, a PR
outside that loop, or a branch reset does not inherit that behavior. Do not infer
that the daemon requested a review unless its comment is present on the PR.

## Verify a review against the exact head

For every final push:

1. Read the current PR head SHA from GitHub after the push.
2. Post `@codex review`; also post `@codex security review` when the change
   affects authorization, parsing, credentials, execution, or other security
   boundaries.
3. Wait for a Codex review receipt created after the request. Compare its
   `commit_id` (and any `Reviewed commit` in the body) with the current GitHub
   head SHA. For inline findings, compare each comment's `commit_id` too.
4. Fix each finding or reply with a reproducible test showing why it does not
   apply. After another push, request and verify both reviews again.

Example read-only checks:

```bash
git rev-parse HEAD
gh pr view NUMBER --json headRefOid
gh api repos/OWNER/REPO/pulls/NUMBER/reviews \
  --jq '.[] | {commit_id, submitted_at, state, body}'
gh api repos/OWNER/REPO/pulls/NUMBER/comments \
  --jq '.[] | {commit_id, created_at, path, line, body}'
```

An old inline thread can stay visible after later commits, and GitHub can retain
review records when a branch is reset to a previously seen SHA. Treat a record
as current only when its commit matches the live head and its timestamp follows
the current review request. A clean `reviewDecision`, an empty inline-comment
list, or a successful push is not a substitute for that receipt. A review with
no findings may have a summary and no inline threads, so verify the review record
as well as comments.

This procedure reflects the repository's observed Codex integration, not a
general guarantee about future GitHub or Codex behavior. If the trigger changes,
update this guide after verifying it with a new exact-head review.
