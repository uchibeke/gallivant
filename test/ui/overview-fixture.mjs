import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOW } from "./fixture.mjs";
export const LONG_REPO = `acme/${"long-repository-name-".repeat(9)}platform`;
export function seedOverview(world) {
  const { state, ctx } = world;
  const ids = ["brief", "prerequisite", "control", "findings", "retry", "ready", "active", "external"].map(slug => `${LONG_REPO}/${slug}`);
  const chain = { name: "release", repo: LONG_REPO, base: "main", status: "active", index: 0, steps: ids.map(id => ({ id })) };
  const common = { repo: LONG_REPO, base: "main", harness: "codex", session: "fixture-session", created_at: "2026-09-24T13:30:00.000Z",
    state: "pr-open", pr: 42, url: `https://github.com/${LONG_REPO}/pull/42`, iteration: 2, cursor: { fixed_sha: "head" }, reviewHead: "head", reviewBinding: "binding" };
  const entries = [
    { state: "needs-human", reason: "prd-changed" },
    { state: "needs-human", reason: "dispatch-refused" },
    { control: { id: "request", action: "resume", status: "failed", finished_at: "2026-09-24T14:10:00.000Z", message: "Fixture: missing prerequisite" } },
    { reviewPolicy: { version: 1, mode: "first-party-required", route: { name: "codex", fingerprint: "f".repeat(64), qualification: "fixture" }, external: null, specialist: null, zeroChecks: true, limits: { timeoutMs: 900000, maxJobs: 2048, retries: 2, budgetUsd: 100, maxInputBytes: 100000 } }, firstPartyReview: { binding: "binding", status: "completed", result: { verdict: "findings", findingsCount: 2 }, disposition: { status: "rounds-exhausted" } } },
    { state: "needs-human", network_retry: { phase: "waiting", run: "attempt", attempts: 1, code: "ENOTFOUND", first_at: "2026-09-24T14:00:00.000Z", next_at: "2026-09-24T14:35:00.000Z" } },
    { state: "ready-for-human", task: { completion: { version: 1, target: "integrated" } }, completionEvidence: { delivery: { repository: LONG_REPO, pr: 47, head: "head", base: "main", gate: { allow: true } } } },
    { state: "running", harness: "claude", last: { run: "active-run", exit: null, at: "2026-09-24T14:15:00.000Z" } },
    { reviewObservation: { head: "head", binding: "binding", external: "waiting", checks: { count: 1, settled: true }, observedAt: NOW } },
  ];
  entries.forEach((entry, i) => state.put(ids[i], { ...common, ...entry, pr: 42 + i, url: `https://github.com/${LONG_REPO}/pull/${42 + i}` }));
  const path = join(world.home, "state.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), chains: { release: chain } }));
  const runner = ctx.runnerFor;
  ctx.runnerFor = id => id === ids[6] ? { current: () => ({ id: "active-run", running: true, startedAt: Date.parse("2026-09-24T14:00:00Z"), exit: null }),
    start() { throw new Error("Fixture cannot dispatch"); }, kill() { throw new Error("Fixture cannot cancel"); } } : runner(id);
  return ids;
}
