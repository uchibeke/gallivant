import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idSlug } from "../../lib/state.mjs";
import { NOW, TASK, RUN } from "./fixture.mjs";

export const OLD_RUN = "2026-09-24T13-00-00-000-plan";
export const REVIEW_POLICY = { version: 1, mode: "first-party-required", route: { name: "codex", fingerprint: "f".repeat(64), qualification: "fixture" }, external: null, specialist: null, zeroChecks: true, limits: { timeoutMs: 900000, maxJobs: 2048, retries: 2, budgetUsd: 100, maxInputBytes: 100000 } };
// Same synthetic fixture for semantic checks and the two approved captures.
export function seedWorkspace(world) {
  world.state.update(TASK, { last: { run: RUN, exit: 0, at: "2026-09-24T14:20:00.000Z" },
    activity_at: "2026-09-24T14:20:00.000Z", url: "https://github.com/acme/atlas/pull/42", reviewPolicy: REVIEW_POLICY,
    reviewHead: "fixture-head", reviewBinding: "fixture-binding", cursor: { fixed_sha: "fixture-head" },
    reviewObservation: { head: "fixture-head", binding: "fixture-binding", checks: { count: 3, settled: false }, external: "waiting", observedAt: NOW },
    firstPartyReview: { binding: "fixture-binding", status: "completed", completedAt: "2026-09-24T14:18:00.000Z",
      result: { verdict: "findings", findings: [{ severity: "high", description: "The search migration needs an explicit rollback path before the index can be replaced." }] },
      disposition: { status: "pending" } },
  });
  const statePath = join(world.home, "state.json");
  writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), chains: { "search-release": { name: "search-release", repo: "acme/atlas", base: "main", status: "active", index: 0, steps: [{ id: TASK }, { id: "acme/atlas/release" }] } } }));
  const root = join(world.home, "runs", idSlug(TASK));
  const old = join(root, OLD_RUN); mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "job.json"), JSON.stringify({ id: OLD_RUN, pid: 0, bin: "/fixture/no-executable", startedAt: Date.parse(NOW) - 5_400_000, endedAt: Date.parse(NOW) - 5_100_000, exit: 0,
    execution: { provider: "codex", model: "recorded-fixture-model", sessionId: "historical-fixture-session", transport: "local", costUsd: 0.12 } }));
  writeFileSync(join(old, "job.log"), "Historical attempt output only\n");
  const current = join(root, RUN, "job.json");
  writeFileSync(current, JSON.stringify({ ...JSON.parse(readFileSync(current, "utf8")), execution: { provider: "codex", model: "recorded-fixture-model", sessionId: "current-fixture-session", transport: "local", costUsd: null } }));
  writeFileSync(join(root, RUN, "result.json"), JSON.stringify({ version: 1, taskId: TASK, runId: RUN,
    outcome: { finished: true, ok: true }, artifacts: [{ path: "src/search/index.mjs", hash: "fixture-artifact-hash" }] }));
  return { root, old };
}
