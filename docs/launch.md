# Announcement drafts

Publish these only after [the release checks](releasing.md#verify-before-announcing)
pass and the linked repository is public. Add a genuine dashboard screenshot or
a short recording of a small task reaching a reviewed PR; do not present fixture
results as live provider evidence.

## X

Write a PRD, mark it ready, go outside.

Gallivant keeps Claude Code and Codex PRs moving: implement → review → fix → CI.
Same session, a local dashboard, and you decide what gets merged.

Open source: https://github.com/uchibeke/gallivant

## LinkedIn

I built Gallivant to reduce the time spent checking whether a coding agent has
finished, reading its review feedback, and sending it back to fix the next issue.

You write a brief with acceptance criteria and verification commands. Gallivant
starts an agent in a separate checkout, watches the pull request, and resumes the
same session when review or CI needs attention. A local dashboard shows progress
and lets you send corrections. It stops when the PR is ready for your review or
needs your help. You still decide what gets merged.

It also supports sequences of briefs: merge one milestone and the next starts
from that updated base. Claude Code and Codex are the recommended starting points.

It's open source, runs on macOS and Linux, and uses your existing harness and
GitHub access. Setup and security boundaries:
https://github.com/uchibeke/gallivant
