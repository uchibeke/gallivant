# Security

Report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/uchibeke/gallivant/security/advisories/new).
If private reporting is unavailable, open an issue requesting a private contact
channel without disclosing the vulnerability. Do not include credentials,
exploit payloads or private run logs in a public issue.

Include the version/commit, affected command, platform, reproduction and expected
permission boundary. Remove tokens and personal data. Fixes target the current
release; there is no separate long-term support branch yet.

Read [the guardrails](docs/guardrails.md) before unattended operation. Local
dashboard access is trusted operator access. Local implementation workers receive
the configured GitHub credential; scope it to the repositories and operations
they need. Automatic approval is not equivalent to an operating-system sandbox.
The [OpenAI Agents API adapter](docs/openai-agents.md) keeps service credentials
on the coordinator and publishes returned artifacts through that coordinator.
Its hosted execution controls differ from local harness hooks and sandboxes.

## Bitbucket reviewer isolation

Use a separate reviewer account and keep its publication credential outside the
coding process's filesystem and environment access. A private file readable by
the coding identity does not provide isolation. The review model receives the
prepared diff and a read-only checkout; an operator publishes its exact-head
verdict. See [reviewer setup](docs/bitbucket-review.md#independent-local-codex-reviewer).
Bitbucket dispatch remains disabled pending live qualification.
