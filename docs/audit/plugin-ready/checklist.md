# Qualification checklist

- [x] Read the frozen PRD and carried G1/G2/G8 contract.
- [x] Keep hosted backends, plugin transport/UI and deployment in later milestones.
- [x] Use one service for CLI and structured prepare/answer/validate/start.
- [x] Preserve original requirements, question/answer IDs and source hashes.
- [x] Exercise the real checker, readiness decision and start machinery offline.
- [x] Review changed source and representative canonical output before pushing.
- [x] Run `npm test`, `npm run lint`, `npm run test:task-intake`, `git diff --check`.
- [x] Test clean packed-package exports/help without global configuration effects.
- [ ] Supply authorized disposable GitHub repo, runtime/model access and live allowance.
- [ ] Run one tiny task via `gallivant task --run`; save request, answers, exact PRD
      revision/source hashes, readiness decision, provider session and start/run IDs.
- [ ] Restart the service, reopen that identity and demonstrate no duplicate dispatch.
- [ ] Force one CI/review correction on that PR; observe the normal daemon's fix and
      final review state. Check actual remote commits, files, tests and PR identity.
- [ ] Record timestamps, exact configured executable/version, implementation commit,
      costs or unknowns and bounded artifact pointers in the evidence JSON. Keep
      sensitive raw logs outside Git. Do not change provider/model or permissions.
- [ ] Claim live qualification only after those observations; never auto-merge.

If a prerequisite or policy refuses a live step, stop that phase, retain false
attestations and record its exact remedy. Do not repeat unchanged calls or replace
the required observation with a fixture. A regular implementation PR can be reviewed
with that external criterion still unverified; it is not a release claim.
