# Network failures and recovery

`ENOTFOUND` means a hostname lookup failed. `EAI_AGAIN` indicates a temporary
resolver failure. Neither proves that a provider is down, credentials expired,
or APort denied a tool call. DNS can affect one hostname while other sites work.

## Automatic local recovery

For a recognized terminal connection error, Gallivant waits 1, 5, then 15 minutes
before up to three automatic resumes, on the next daemon tick after each deadline.
It preserves the session, checkout, pending work, review cursors and approved brief.
The normal resume preflight, permissions, dirty-work preservation and completion
gates still apply. A connection failure with no published progress does not count
as a completed review round. A run that pushed before failing is accounted for
normally and returns to review/CI monitoring; it cannot evade the round budget.
Retries may incur provider charges, subject to existing per-run and task allowances;
the retry budget is separate from `max_iterations`.

Counts and deadlines survive daemon restarts. The window begins when the terminal
failure is observed, before GitHub reconciliation; a simultaneous GitHub outage
cannot extend it. Published progress must still be reconciled before retrying.
No retry starts after the one-hour recovery window expires; an already-started
run retains its normal runtime limit.
The shared completion projection keeps pending retries monitored, so embedded
hosts continue waking the coordinator instead of treating the task as paused.
Exhaustion stops with `provider-network-exhausted` and notifies the operator.
Success or reconciled published progress resets the consecutive failure streak.
A manually authorized Resume starts a new streak after normal preflight.

Only short terminal errors containing `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`,
`ECONNREFUSED` or `ETIMEDOUT` qualify. Missing results, unknown errors, authentication
failures, quota errors, policy denials, cancelled tasks and unknown process ownership
do not trigger automatic replay. A crash during launch stops for inspection rather
than guessing whether input was sent. Unrecognized error formats require manual
inspection. Hosted execution retains its transport reconciliation: this mechanism
never resubmits an ambiguously accepted remote operation.

Status, the dashboard and `gallivant why <handle>` show the error, retry count and
deadline. “Signed-in (API unchecked)” means the local version/login checks passed;
it does not prove inference access. OpenCode reports credential presence; Gemini
and Goose report only that the binary runs, with authentication unchecked.
**Recheck PR** refreshes review and CI; it cannot
clear a failed agent or pending network recovery. **Resume agent** continues the
session after you repair its prerequisites. Upgrades do not silently restart old
stopped jobs; resume those explicitly once.

Readiness checks use a bounded 20-second coordinator deadline by default; an
explicit `execution.deadlineMs` overrides it. A timeout or cancelled check leaves
dispatch blocked until a successful refresh, but does not prove credentials are
invalid. The remedy is to inspect host load/connectivity and retry the check,
rather than automatically logging in or reinstalling the CLI. Pending refreshes
are reported as pending checks.

## Portable diagnosis

Use the actual provider origin configured for your harness. For default Claude:

```sh
gallivant doctor --network https://api.anthropic.com
gallivant doctor --network https://api.anthropic.com --json
```

No config, login or daemon is required. This takes three bounded samples using
Node's OS DNS resolver and credential-free HTTPS, without `dig`, `curl`, `sudo`,
systemd, launchd or a desktop. It sends HEAD requests only to your supplied HTTPS
origin, follows no redirects, and rejects credentials, paths, queries and fragments.
HTTP 401/403/404 proves an HTTPS response was received, not model access. Exit 0
requires every sample to pass; exit 1 indicates a failure or invalid input.
Passing samples cannot rule out an intermittent failure.

HTTPS testing is direct, without proxy forwarding. Proxy environment presence is
reported without its values. If a proxy is mandatory, use your administrator's
approved proxy diagnostic too. This test does not qualify the harness's proxy route.

Capture results during a failure and compare on another approved network. If only
router DNS fails while direct queries to an approved resolver succeed, repair the
router or configure that resolver through your network administrator. If OS lookup
fails while direct DNS works, inspect the resolver, VPN and endpoint-filter logs.
Linux users can use `resolvectl status` where systemd-resolved is installed;
otherwise use the distribution's network manager. Do not blindly overwrite a
managed `/etc/resolv.conf`. On macOS use Network settings and filter logs.
Do not disable TLS validation, firewalls or sandboxing to hide the failure.

After repair:

```sh
gallivant why <handle>
gallivant resume <handle>
```

## Platform and release qualification

Recovery uses Node 22+ and the existing runner, with no macOS-specific commands.
CI exercises Node 22/24 on Ubuntu Linux and macOS, including tarball installation.
That is not a guarantee for every Linux distribution, container or provider CLI.
Process inspection and the selected harness's runtime/sandbox remain prerequisites;
hosted-result verification needs the isolation tools in [installation](install.md).
Missing isolation fails closed. The coordinator must remain awake and running.

Require the full CI matrix and package smoke test before release, then qualify a
small live task in the intended environment. See [release readiness](releasing.md).
