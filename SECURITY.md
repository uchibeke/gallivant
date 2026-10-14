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
dashboard access is trusted operator access, GitHub tokens reach agent processes,
and automatic approval is not equivalent to an operating-system sandbox.
