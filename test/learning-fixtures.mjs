import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLearningService } from "../lib/learning.mjs";
import { learningStore } from "../lib/learning_store.mjs";
import { makeTrust } from "../lib/events.mjs";

export const repo = { host: "github.com", id: "1234" }, foreign = { host: "github.com", id: "9999" };
export const now = "2026-10-07T00:00:00.000Z";
const trust = makeTrust({ trusted_authors: ["maintainer"], reviewer: { login: "reviewer[bot]" } }, "maintainer");
export const snapshot = (body = "Validate the error before changing state.", overrides = {}) => ({
  pr: { number: 1, repo: "example/project", updated_at: "2026-10-06T00:00:00Z", headRefOid: "b".repeat(40) },
  inline: [{ id: 77, user: { login: "reviewer[bot]", type: "Bot" }, path: "src/input.mjs", body, created_at: "2026-09-15T00:00:00Z", updated_at: "2026-10-06T00:00:00Z", original_commit_id: "a".repeat(40), ...overrides }],
});
export const proposed = (evidence, changes = {}) => ({ version: 1, id: "lesson-validation", repo, paths: [], applicability: "When parsing external input", guidance: "Validate all fields before persisting state.", rationale: "A late validation failure otherwise leaves partially changed state.", example: "Before: persist then validate. After: validate the complete input then persist.", evidence: [evidence], disposition: "unconfirmed", regression: null, provenance: { provider: "offline-fixture", inputDigest: "f".repeat(64), at: now }, ...changes });
export function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "learning-test-")), root = join(dir, "state");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = learningStore(root), service = createLearningService({ root, store, clock: { now: () => Date.parse(now) }, trust, ...extra });
  return { dir, root, store, service };
}
export async function observed(service) { await service.configure(repo, "collect"); await service.observe(repo, snapshot()); return service.report(repo); }
export async function pending(service, store, changes = {}) { await observed(service); const evidence = Object.keys(store.load(repo).observations)[0]; return service.revise(repo, changes.id || "lesson-validation", proposed(evidence, changes)); }
