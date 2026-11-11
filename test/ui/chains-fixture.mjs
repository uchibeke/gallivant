import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueChain } from "../../lib/chains.mjs";
import { GOOD_PRD } from "../helpers.mjs";
import { NOW, TASK, RUN } from "./fixture.mjs";

export const CHAIN = "search-release";
export const RECOVERY = "input-recovery";
// Synthetic chain observations and fake host boundaries. The real service reads
// only this temporary checkout; start/kill remain fixture tripwires.
export async function seedChains(world) {
  const { state, home, ctx } = world;
  let hostReads = 0;
  const checkout = join(home, "operator");
  mkdirSync(join(checkout, "docs/prds"), { recursive: true });
  const source = join(checkout, "docs/context.md");
  writeFileSync(source, "Approved fixture source\n");
  const paths = ["prepare-index", "release-index"].map(slug => {
    const path = join(checkout, "docs/prds", `${slug}.md`);
    writeFileSync(path, GOOD_PRD.replace("harness: codex", "harness: codex\nsources:\n  - docs/context.md"));
    return path;
  });
  ctx.config.harness = { codex: { bin: "/fixture/no-executable" } };
  ctx.git = { toplevel: async () => checkout };
  ctx.gh = {
    repoInfo: async () => { hostReads++; return { nameWithOwner: "acme/atlas", defaultBranch: "main" }; },
    branchExists: async () => { hostReads++; return true; },
    refSha: async () => { hostReads++; return "b".repeat(40); },
    fileAtStrict: async () => { hostReads++; return null; },
  };
  await queueChain(ctx, { name: RECOVERY, paths });
  state.updateChain(RECOVERY, { status: "stopped", reason: "queued PRD or sources changed; review before resnapshot", updated_at: NOW });
  writeFileSync(source, "Changed fixture source: preserve migration rollback.\n");
  const common = { digest: "c".repeat(64), baseFiles: { "docs/context.md": "d".repeat(64) }, harness: "codex" };
  const step = (slug, more = {}) => ({ ...common, id: `acme/atlas/${slug}`, relPath: `docs/prds/${slug}.md`, ...more });
  const chain = { name: CHAIN, repo: "acme/atlas", base: "main", status: "active", index: 1, created_at: NOW, updated_at: NOW, reason: null,
    steps: [step("foundation", { dispatch: "fixture-foundation", entry: { pr: 41 }, merged: { pr: 41, sha: "a".repeat(40), at: NOW } }),
      step("search-index", { dispatch: "fixture-search", entry: { pr: 42 } }), step("migration-rollout"), step("release-verification")] };
  state.update(TASK, { state: "ready-for-human", reason: null, last: { run: RUN, exit: 0, at: NOW }, url: "https://github.com/acme/atlas/pull/42",
    cursor: { fixed_sha: "fixture-head" }, task: { completion: { version: 1, target: "integrated" } },
    completionEvidence: { delivery: { repository: "acme/atlas", pr: 42, head: "fixture-head", base: "main", gate: { allow: true } } } });
  state.put("acme/atlas/foundation", { ...state.get(TASK), prd: "docs/prds/foundation.md", branch: "work/foundation", pr: 41, url: "https://github.com/acme/atlas/pull/41", state: "done", completionEvidence: { terminal: { state: "MERGED" } } });
  const file = join(home, "state.json"), saved = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...saved, chains: { [CHAIN]: chain, ...saved.chains } }));
  return { chain, source, paths, hostReads: () => hostReads };
}
