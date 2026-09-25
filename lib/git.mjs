// Checkouts for sessions. Each PRD gets its own partial clone at <worktrees>/<owner>/<repo>/<prd id>, so the
// operator's own checkout is never touched, two PRDs never collide, and a lost registry can recreate it from the
// PR branch with nothing but the repo name. It is called a worktree throughout because that is what it is to the
// session; under the hood it is `git clone --filter=blob:none`, which fetches blobs on demand.
import { join } from "node:path";
import { exists, ensureDir } from "./fs.mjs";
import { execFileAsync, readTokenFile } from "./gh.mjs";

const CLONE_TIMEOUT_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const PREFIX = "gallivant/";

export const worktreePath = (config, nameWithOwner, prdId) => join(config.worktrees, ...nameWithOwner.toLowerCase().split("/"), prdId);

/** The branch naming convention, in one place with its inverse. */
export const branchFor = prdId => `${PREFIX}${prdId}`;
export const isOurBranch = branch => typeof branch === "string" && branch.startsWith(PREFIX);
export const prdIdFromBranch = branch => (isOurBranch(branch) ? branch.slice(PREFIX.length) : null);

/** Env for anything that runs git or gh inside a worktree: Gallivant's gitconfig, and its token when configured. */
export function runEnv(config) {
  const env = { GIT_CONFIG_GLOBAL: join(config.home, "gitconfig") };
  const token = readTokenFile(config.github_token_file);
  if (token) env.GH_TOKEN = token;
  return env;
}

export function makeGit({ config, exec = execFileAsync } = {}) {
  const env = () => ({ ...process.env, ...runEnv(config) });
  const git = (args, cwd, timeout = GIT_TIMEOUT_MS) => exec("git", args, { cwd, env: env(), timeout }).then(r => r.stdout.trim());
  const gh = (args, cwd, timeout = CLONE_TIMEOUT_MS) => exec("gh", args, { cwd, env: env(), timeout }).then(r => r.stdout.trim());

  return {
    /** Fresh worktree on a new branch from the remote default branch. */
    async create({ nameWithOwner, prdId, defaultBranch }) {
      const path = worktreePath(config, nameWithOwner, prdId);
      if (exists(join(path, ".git"))) throw new Error(`worktree already exists at ${path}`);
      ensureDir(join(path, ".."), 0o755);
      await gh(["repo", "clone", nameWithOwner, path, "--", "--filter=blob:none", "--no-checkout"]);
      await git(["checkout", "-b", branchFor(prdId), `origin/${defaultBranch}`], path);
      return path;
    },
    /**
     * Worktree for an existing PR branch, used by `register` and by recovery. Idempotent. When the directory
     * exists it must be a clone of the same repository on that branch; anything else is an error, never silently
     * reused.
     */
    async fromBranch({ nameWithOwner, prdId, branch, path = worktreePath(config, nameWithOwner, prdId) }) {
      if (exists(join(path, ".git"))) {
        const origin = await git(["remote", "get-url", "origin"], path);
        if (!origin.toLowerCase().includes(nameWithOwner.toLowerCase())) throw new Error(`${path} is a clone of ${origin}, not ${nameWithOwner}`);
        await git(["fetch", "origin", branch], path);
        await git(["checkout", branch], path);
        return path;
      }
      ensureDir(join(path, ".."), 0o755);
      await gh(["repo", "clone", nameWithOwner, path, "--", "--filter=blob:none", "--branch", branch]);
      return path;
    },
    exists: path => exists(join(path, ".git")),
    toplevel: dir => git(["rev-parse", "--show-toplevel"], dir),
  };
}
