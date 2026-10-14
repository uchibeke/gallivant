# Announcement drafts

Publish these only after [the release checks](releasing.md#verify-before-announcing)
pass and the repository is public. Use the install command that actually works
for the released version; do not advertise npm installation before publication.
Add a genuine dashboard screenshot or recording of a task reaching a reviewed
PR. Fixture tests are not live provider evidence.

## X

Give an agent a task. Let the review loop run. Go outside.

Gallivant turns requests into reviewed PRs: code, docs or research. Local or
hosted agents, review/CI fixes, and a dashboard for corrections. You choose
what merges.

https://github.com/uchibeke/gallivant

## LinkedIn

I built Gallivant to reduce the time spent checking whether an agent has
finished, collecting review feedback, and sending it back for the next fix.

Start with a plain-language request or a written brief. Gallivant keeps the
requirements, implementation, tests and PR review together. It watches reviews
and CI, continues the same session for corrections, and reports when the result
is ready for you or needs help. A local dashboard lets you follow progress and
message the agent.

This also works for research, documentation and content delivered as repository
files. For longer plans, merge one milestone and the next starts from that base.
You retain the merge decision.

Claude Code and local Codex are the recommended starting points. An explicit
OpenAI Agents API integration supports hosted preparation and execution with
separate account, permission and billing requirements. The support table
separates implemented adapters from live qualification; Codex Cloud dispatch
remains disabled until its repository binding can be verified.

Gallivant runs on macOS and Linux. Its coordinator still needs to stay online,
even when the agent runs remotely. Setup, examples and operating boundaries:
https://github.com/uchibeke/gallivant
