# Review capacity and unattended execution audit

The real Bitbucket runs stopped before any corrective coding round. Backend
review required 29 pieces against a maximum of 20. Frontend and sales review
received only piece 1 of 6 and 1 of 9 respectively, then attempted to judge the
entire PR and correctly refused missing context. Increasing coding rounds alone
could not repair either failure.

| Setting | Previous default / ceiling | New default / ceiling |
| --- | --- | --- |
| Coding fix rounds | 30 | 60 |
| Coding per-run allowance | $5 | $50 |
| Reviewer jobs per task, across heads and synthesis | 4 / 20 | 2,048 / 8,192 |
| Review accounting allowance | $4 / $100 | $100 / $10,000 |
| Reviewer job timeout | 3 / 15 minutes | 15 / 60 minutes |
| Known pre-dispatch review retries | 1 | 2 |
| Configurable planner calls | 3 | 12 |
| Configurable planner input/output token ceilings | 50,000 / 6,000 | 100,000 / 16,000 |
| Configurable planner allowance ceiling | $0.10 | $10 |
| Planner request timeout | 1 / 2 minutes | 2 / 5 minutes |

The review allowance accommodates 61 reviews of a 29-piece change plus final
synthesis (1,830 jobs) within the default 60-fix-round lifecycle. It remains
finite and does not expand itself. Codex USD reservations are accounting only;
they do not guarantee a provider billing cap or establish actual model cost.
Explicit provider ceilings, approved task/delivery allowances and deliberately
lower settings remain binding. Hosted adapters still require explicit account
authorization; no new provider spend or credentials are inferred from defaults.

Each split inspection now judges its supplied scope and returns source-quoted,
bounded observations and defects. A separate whole-PR reviewer must assess all
validated reports and criteria before clearance. A local clear result cannot
clear a PR. Unsupported quotes, empty reports, unresolved scope, incomplete
pieces and stale bindings remain failures. Prompt size remains 100,000 bytes;
source capture has an independent 16 MiB cap instead of scaling indefinitely
with the larger job count.

Restricted Codex preparation no longer copies disabled plugin and skill caches
into every piece's private home. Selected authentication, configuration and
managed-policy files remain available and the native tools-off check remains
mandatory. Operator caches are preserved. This bounds repeated startup and disk
work instead of multiplying unrelated cache contents by the higher job count.

Captured reviews advance locally between host polls. A terminal local result
wakes the ordinary host lane, which must reread the live PR binding before
readiness or corrective dispatch. Recheck and policy changes clear the old
polling deadline. UI and CLI show review progress separately from coding rounds;
the latter counts settled corrective runs, not commits or reviewer calls.

Verification: the full suite passed 2,027 tests with one optional skip. The
review/control/status/UI regressions passed 177 tests; the separate planner suite
checks the raised ceilings and preservation of explicit lower authorizations.
The real sales piece that previously refused missing other pieces returned
source-backed findings, five verified observations and no unresolved scope in
native run `run-384d0d43-01f3-4979-8d21-5c759fb305df`, against head
`34ba3a9786a2781058613e92a61de5f0c864d962`. This was a scoped diagnostic;
it is not a whole-PR clear verdict. No production PR was merged or deployed.

## Review follow-up

Two additional regressions were reproduced and repaired. Removing duplicated
diff text can yield one local-scope piece from an oversized original prompt; that
piece now requires whole-PR synthesis just like a multi-piece partition. A
35,000-character added-line regression exercises the full coordinator path.

Large collections of individually bounded reports now use hierarchical scoped
reductions before final review. A 3 MB added-line regression validates all source
outputs and every reduction prompt against the 100,000-byte bound, proves exact
coverage of the original ordered reports, rejects missing/duplicate ranges and
unsupported parent quotes, and reaches a bounded final input. Coordinator tests
also verify recovery of an in-flight reduction after restart and that no local
or intermediate verdict can clear before final synthesis. All reduction jobs
use the existing task allowance and durable execution namespace.

The broader follow-up also exercises reused preparation homes: excluded caches
and their old aliases are removed by rebuilding the private Codex root after
validating source/private separation. Native authentication and resource files
remain unchanged. A regression covers a private-root alias to the operator's
profile and verifies overlap refusal occurs before cleanup.
