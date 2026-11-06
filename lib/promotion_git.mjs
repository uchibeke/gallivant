import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileAsync, transportExecutor } from "./process.mjs";
import { runEnv } from "./git.mjs";
import { shellQuote } from "./runtime-environment.mjs";

/** Git's pre-push hook receives the actual advertised old OID. The server then
 * compares that old OID atomically. This closes the planning/push race without
 * --force or a lease that could permit a non-fast-forward update. */
export function pushGuard({ branch, head, previous }) {
  return `const fs = require('node:fs');
const rows = fs.readFileSync(0, 'utf8').trim().split('\\n').map(s => s.split(/\\s+/));
const expected = ${JSON.stringify({ branch, head, previous })};
if (rows.length !== 1 || rows[0].length !== 4 || rows[0][1] !== expected.head || rows[0][2] !== 'refs/heads/' + expected.branch || rows[0][3] !== (expected.previous || '0'.repeat(expected.head.length))) {
  process.stderr.write('Promotion target changed: inspect a fresh dry-run plan.\\n'); process.exit(1);
}`;
}

/** Isolated object transfer: never checkout/execute repository files or copy
 * credentials. Each network call gets only that host's existing bound Git auth. */
export async function makePromotionTransfer(ctx, { execute = execFileAsync } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "branch-promotion-"));
  const exec = transportExecutor(execute);
  const clean = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GH_|GITHUB_|BITBUCKET_|BB_|SSH_|HOST_API_)/.test(key)));
  const git = async (args, repo = null) => {
    const credential = repo ? await ctx.hosts.gitCredential(repo) : null;
    const env = { ...clean(), ...runEnv(ctx.config, credential), GIT_TERMINAL_PROMPT: "0" };
    const { stdout } = await exec("git", args, { cwd: dir, env, timeout: 300_000 });
    return stdout.trim();
  };
  try { await git(["init", "--bare", "."]); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const fetchRef = async (repo, ref, slot, expected) => {
    const remote = ctx.hosts.remote(repo);
    await git(["fetch", "--no-tags", "--no-recurse-submodules", remote.url, `+${ref}:refs/promotion/${slot}`], repo);
    if (await git(["rev-parse", `refs/promotion/${slot}^{commit}`]) !== expected) throw new Error("Remote Git ref changed or differs from host API evidence; inspect a new plan");
  };
  const ancestor = async (before, after) => {
    try { await git(["merge-base", "--is-ancestor", before, after]); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  };
  return {
    async validate(plan) {
      await fetchRef(plan.source.repo, `refs/pull/${plan.source.number}/head`, "source", plan.source.head);
      await fetchRef(plan.source.repo, plan.source.baseHead, "source-base", plan.source.baseHead);
      await fetchRef(plan.target.repo, `refs/heads/${plan.target.base}`, "target-base", plan.target.baseHead);
      if (plan.target.head) await fetchRef(plan.target.repo, `refs/heads/${plan.target.branch}`, "target", plan.target.head);
      if (!await ancestor(plan.source.baseHead, plan.source.head)) throw new Error("Source branch does not contain its reviewed base; reconcile and review before promotion");
      const sourceTree = await git(["rev-parse", `${plan.source.baseHead}^{tree}`]);
      const targetTree = await git(["rev-parse", `${plan.target.baseHead}^{tree}`]);
      if (sourceTree !== targetTree) throw new Error("Source reviewed base and Bitbucket base trees differ; reconcile on GitHub and review again before promotion");
      if (plan.target.head && !await ancestor(plan.target.head, plan.source.head)) throw new Error("Bitbucket branch diverged; promotion never force-pushes or rewrites history");
    },
    async push(plan) {
      const hooks = join(dir, "promotion-hooks");
      await mkdir(hooks, { recursive: true });
      await writeFile(join(hooks, "pre-push"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} --input-type=commonjs -e ${shellQuote(pushGuard({ branch: plan.target.branch, head: plan.source.head, previous: plan.target.head }))}\n`, { mode: 0o700 });
      await git(["-c", `core.hooksPath=${hooks}`, "push", "--no-follow-tags", ctx.hosts.remote(plan.target.repo).url, `${plan.source.head}:refs/heads/${plan.target.branch}`], plan.target.repo);
    },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
