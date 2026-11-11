// Service-backed synthetic intake. Real task, revision, readiness and start
// services; fake inference, host, checkout creation, runner and daemon only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixture.mjs";
import { draftFor } from "../fixtures/task-intake.mjs";
import { CONFIG, harnessBin, fakeCredential, fakeIdentity, fakeRunner } from "../helpers.mjs";
import { capabilitiesFor, PREPARATION_BOUNDARY } from "../../lib/harness.mjs";
import { newEntry, STATES } from "../../lib/state.mjs";
import { ready } from "../../lib/commands/ready.mjs";
import { start } from "../../lib/commands/start.mjs";

export const INTAKE_REQUEST = "Add CSV export for the widget table.\nDo not add dependencies.";
export async function intakeFixture({ question = true, unsupported = false, missing = false, selectedVerify = null, ...options } = {}) {
  const world = await fixture({ ...options, empty: true }), { ctx, home, state } = world;
  try {
    const checkout = join(home, "operator"); mkdirSync(checkout);
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "node --check index.mjs" } }));
    writeFileSync(join(checkout, "AGENTS.md"), "Keep export scoped to the table. Verify with `npm test` and `npm run lint`.\n");
    const runners = new Map(), snapshots = new Map(), sources = new Map();
    const calls = { prepare: 0, ready: 0, start: 0, daemon: 0, git: 0, host: 0 };
    ctx.env = { PATH: process.env.PATH, HOME: home };
    ctx.config = { ...CONFIG, home, worktrees: join(home, "worktrees"), repos: [{ repo: "acme/widget", base: "main" }],
      harness: { codex: { bin: harnessBin(home) } }, deliverable: { ...CONFIG.deliverable, evaluator: "local" } };
    ctx.capabilitiesFor = name => ({ ...capabilitiesFor(name), ...(name === "codex" ? { preparation: unsupported ? null : { version: 1, boundary: PREPARATION_BOUNDARY, authority: "text-only" } } : {}) });
    ctx.credential = fakeCredential(); ctx.identity = fakeIdentity();
    ctx.git = { toplevel: async dir => { calls.git++; if (dir !== checkout) throw Error("fixture checkout mismatch"); return checkout; },
      create: async ({ prdId }) => { calls.git++; const path = join(home, "worktrees", "acme", "widget", prdId); mkdirSync(path, { recursive: true }); return path; } };
    ctx.gh = { repoInfo: async () => { calls.host++; return { nameWithOwner: "acme/widget", defaultBranch: "main" }; }, branchExists: async () => true, ensureLabels: async () => {} };
    ctx.runnerFor = id => { if (!runners.has(id)) runners.set(id, fakeRunner(ctx.clock)); return runners.get(id); };
    ctx.writePrd = (id, text) => snapshots.set(id, text); ctx.readPrd = id => snapshots.get(id);
    ctx.writeSource = (id, rel, text) => sources.set(`${id}:${rel}`, text); ctx.readSource = (id, rel) => sources.get(`${id}:${rel}`);
    if (!missing) state.put("acme/widget/source", newEntry({ repo: "acme/widget", prd: "docs/prds/source.md", branch: "work/source", harness: "codex", checkout, state: STATES.done }));
    let preparationFailure = null;
    ctx.taskIntakeOptions = {
      prepare: async (_ctx, task) => {
        calls.prepare++; if (preparationFailure) throw preparationFailure;
        const output = draftFor(task, { question });
        if (selectedVerify) output.verify = selectedVerify;
        return JSON.stringify(output);
      },
      decideReady: async options => { calls.ready++; return ready(options); },
      dispatch: async (context, options) => { calls.start++; return start(context, options); },
      daemon: async () => { calls.daemon++; },
    };
    return { ...world, calls, runners, checkout, failPreparation: error => { preparationFailure = error; } };
  } catch (error) { await world.close(); throw error; }
}
