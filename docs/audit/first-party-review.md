# First-party review qualification and evaluation

Date: 2026-11-01. Status: **live qualification blocked; quality baseline unmeasured**.

The configured executable was inspected at `/Users/uchi/.local/share/gallivant/codex/node_modules/.bin/codex`. Its `exec --help` exposed strict configuration and sandbox controls. A configuration-only call through the existing `buildPreparationRun(...).configure(...)` boundary returned:

```text
TASK_PREPARATION_BOUNDARY
Codex preparation configuration could not be isolated: effective configuration could not be verified; check managed Codex policy and the supported CLI version; no drafting call was made
```

No inference call was made, and neither model access nor runtime confinement was established. The observed selected model was `gpt-6-astra`; it was not changed. Browser/plugin capture is not required by this repository feature. GitHub repository access was confirmed by `gh api repos/uchibeke/gallivant --jq '{full_name,permissions}'`. An APort identity was not present in this session environment; no new identity was registered.

Remedy: an administrator must supply an approved native configuration/CLI combination whose effective profile passes the restricted boundary check. Then authorize the disposable live qualification and model evaluation against an independently reviewed baseline, with provider access and a bounded allowance. Do not weaken permissions, replace this failure with fixture output, or change the provider/model to evade the failure.

| Measurement | First-party live result | External/human baseline |
| --- | --- | --- |
| Seeded defect detection | Unmeasured | Unavailable |
| False-positive rate | Unmeasured | Unavailable |
| Latency | Unmeasured | Unavailable |
| Actual spend | Unknown; native cost reporting unavailable | Unavailable |
| Fresh-session confinement | Native configuration check failed | Not applicable |

`test/first-party-review.test.mjs` provides deterministic coordinator coverage. `test/fixtures/review-held-out.json` contains seeded correctness, security, missing-criterion, deletion, regression, clean and injection examples. These are validation/evaluation inputs, not claims that a live model detected the defects. Failure, disagreement, changing input, large evidence, duplicate polling and timeout behavior are tested separately.

`lib/review_evaluation.mjs` computes detection, false positives, latency and spend from captured outputs and an independently supplied external/human baseline. Missing records or unknown cost stay explicit. Keep first-party selection opt-in; no measured evidence here justifies a default migration. In particular, ac-2 (live security qualification), ac-8 (a guaranteed monetary ceiling) and ac-10 (measured live quality/cost baseline) remain unproven in this environment.

Local verification: `npm test` passed with 1,902 passing tests, zero failures and one Linux-only isolation test skipped on macOS (`/tmp/first-party-npm-test-final.log`). The final focused review/event regression run passed all 43 tests (`/tmp/first-party-exact-head-final.log`). `npm run lint` and `git diff --check` passed. These checks establish deterministic behavior, not the unavailable live security or quality attestations above.
