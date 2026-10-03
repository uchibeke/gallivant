// Checkouts for sessions. Each PRD gets its own partial clone at <worktrees>/<owner>/<repo>/<prd id>, so the
// operator's own checkout is never touched, two PRDs never collide, and a lost registry can recreate it from the
// PR branch with nothing but the repo name. It is called a worktree throughout because that is what it is to the
// session; under the hood it is `git clone --filter=blob:none`, which fetches blobs on demand.
import { join } from "node:path";
import { exists, ensureDir } from "./fs.mjs";
import { writeRepositoryText } from "./repository_files.mjs";
import { execFileAsync, remoteMatches, repoFromRemote } from "./gh.mjs";
import { COMMIT_MSG_HOOK } from "./attribution.mjs";

const CLONE_TIMEOUT_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const PREFIX = "gallivant/";
const cloneUrl = repo => `https://github.com/${repo}.git`;

export const worktreePath = (config, nameWithOwner, prdId) => join(config.worktrees, ...nameWithOwner.toLowerCase().split("/"), prdId);

/** The branch naming convention, in one place with its inverse. */
export const branchFor = prdId => `${PREFIX}${prdId}`;
export const isOurBranch = branch => typeof branch === "string" && branch.startsWith(PREFIX);
export const prdIdFromBranch = branch => (isOurBranch(branch) ? branch.slice(PREFIX.length) : null);

/**
 * Git config for a run, as the pairs git's own `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` variables take. Exported so a
 * test can assert what a run is given without reconstructing the numbering.
 *
 * The helper is a shell snippet git runs with `sh -c` when it needs a credential, and it reads `GH_TOKEN` out of the
 * run's own environment. Nothing operator-supplied is interpolated into it: the value is this literal, and the token
 * travels separately as `GH_TOKEN`. That is deliberate. A snippet assembled from a config value would be a shell
 * injection with a config file as its input.
 */
export const RUN_GIT_CONFIG = [
  ["push.default", "current"],
  ["credential.helper", `!f() { test -n "$GH_TOKEN" && printf 'username=x\\npassword=%s\\n' "$GH_TOKEN"; }; f`],
];

/**
 * The identity pairs, from the operator's own resolved `{ name, email }`.
 *
 * These used to be `gallivant <gallivant@users.noreply.github.com>` literals in the list above. They are not literals
 * any more because a run commits AS THE OPERATOR: they wrote the brief and are shipping the work, and a bot committer
 * tells a reviewer a robot did it. lib/identity.mjs carries the whole reasoning and is where the values come from.
 *
 * Still passed on the command line, which is the half that was always right: nothing in a repository can override a
 * value set there, so no `.git/config` a session writes can change who a commit is from.
 */
export const identityConfig = ({ name, email }) => [["user.name", name], ["user.email", email]];

/**
 * The same isolation the git variables give, for node's package managers, which have the identical problem and had no
 * equivalent treatment.
 *
 * Every one of these was being typed by hand, on every command, in four consecutive live runs, because the session
 * discovered the failure and worked out the workaround itself each time. That is the signal they belong in the run's
 * environment rather than in a session's memory.
 *
 * `NPM_CONFIG_USERCONFIG` stops npm and pnpm reading `~/.npmrc`. Under a sandbox that denies reads outside the
 * worktree, that read fails the command outright (`EPERM ... open '/Users/<you>/.npmrc'`). It is worth doing even
 * without a sandbox: that file holds a live npm auth token, and nothing a Gallivant run does needs it.
 *
 * The other two stop a `"packageManager": "pnpm@x.y.z"` field in the repository's own package.json sending the run
 * off to a self-installed binary under `~/Library/pnpm/.tools`, which is both outside the worktree (so denied) and a
 * version the operator never chose to install. The run uses whatever pnpm is on PATH instead.
 *
 * `/dev/null` is a path, and the only one here, for the reason `GIT_CONFIG_GLOBAL` already gives: every sandbox
 * permits it, and the alternative of leaving the variable unset sends the tool to the operator's home directory.
 */
export const NODE_TOOLING_ENV = Object.freeze({
  NPM_CONFIG_USERCONFIG: "/dev/null",
  npm_config_manage_package_manager_versions: "false",
  COREPACK_ENABLE_AUTO_PIN: "0",
});

/**
 * Env for anything that runs git or gh inside a worktree: every git setting a run needs, and a credential when one
 * was resolved. `credential` is the object `resolveCredential` returns (lib/credential.mjs); pass none and the run
 * gets the settings and no token, which is what the read-only callers (`originOf`, `currentBranch`) need.
 *
 * Nothing here names a file outside the worktree, and that is the whole point of its current shape.
 *
 * This used to be `GIT_CONFIG_GLOBAL=~/.gallivant/gitconfig`, with the credential helper in that file. A sandboxed
 * session cannot read outside its worktree, so every git command failed with
 *
 *     fatal: unable to access '/Users/<you>/.gallivant/gitconfig': Operation not permitted
 *
 * including `git status`. The token was in the environment the whole time and unusable, because the file that would
 * have read it could not itself be read. A live run implemented nine acceptance criteria, committed four times, and
 * could not push. Two sessions then diagnosed it as `~/.git-credentials` being denied, because that is the path git
 * names in its fallback message, not the one it actually failed on.
 *
 * `GIT_CONFIG_COUNT` and its numbered pairs are git's own way to pass config with no file at all, so the settings
 * travel with the run instead of being something the run has to be granted access to read. A sandbox that denies
 * everything outside the worktree is then the correct setting rather than an obstacle. `runEnv` takes no path from
 * `config` for this reason, and a test asserts that every value it returns is free of absolute paths.
 *
 * Two variables do the isolating, and both are load-bearing:
 *
 *  - `GIT_CONFIG_NOSYSTEM=1` drops the SYSTEM file. On any Mac with the Xcode command line tools that file is
 *    `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig` and it sets
 *    `credential.helper = osxkeychain`. Verified: without this, `git config --list --show-origin` reports that
 *    helper from that file even with `GIT_CONFIG_GLOBAL` pointed elsewhere, so a run had a path to the operator's
 *    keychain whatever else was set. With it, `git config --get-all credential.helper` exits 1.
 *  - `GIT_CONFIG_GLOBAL=/dev/null` drops the GLOBAL file. It is a path, and the only one here, but it is a device
 *    every sandbox permits; the alternative of leaving it unset makes git read `$HOME/.gitconfig`, which is outside
 *    the worktree and is the class of failure this whole function exists to end.
 *
 * What is NOT bounded by this, stated plainly because it is not new and is easy to mistake for new: a run's own
 * `.git/config` is still read, `credential.helper` is multi-valued, and a repo-local helper is consulted first. That
 * was equally true when the helper lived in a global file. A run controls its worktree, so it can always add one; the
 * control that bounds a run is the token's scope and the branch ruleset, not the transport of the config.
 *
 * The token reaches the helper through this environment and nothing else. It is never an argument, so `ps` cannot
 * show it, and nothing here writes it to a file.
 */
export function runEnv(_config = null, credential = null, identity = null, worktree = null) {
  // The identity pairs join the fixed ones only when one was resolved. A run with no identity is refused before it is
  // spawned (`requireIdentity`), so the null case here is a git call that commits nothing: the daemon's own read-only
  // ones (`originOf`, `currentBranch`), or `doctor`'s probe. Anything that COMMITS must be given an identity, because
  // this function's own `GIT_CONFIG_GLOBAL=/dev/null` is what leaves the clone without one; `makeGit` says what git
  // does when it is not, and it is not a clean failure on every platform.
  const pairs = [...RUN_GIT_CONFIG, ...(identity?.name && identity?.email ? identityConfig(identity) : [])];
  const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: String(pairs.length) };
  for (const [i, [key, value]] of pairs.entries()) { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; }
  if (credential?.token) env.GH_TOKEN = credential.token;
  // gh loads config even with GH_TOKEN. A sandboxed run cannot read ~/.config/gh, so keep its CLI state inside
  // Gallivant's private clone. The directory may be absent; gh uses defaults. No personal credentials are copied.
  if (worktree) env.GH_CONFIG_DIR = join(worktree, ".git", "gallivant-gh");
  return { ...env, ...NODE_TOOLING_ENV };
}

/**
 * Git for the daemon's own clones and fetches.
 *
 * `credential` is a function so the token is resolved when a command actually runs rather than captured at
 * construction. The daemon is long-lived and the operator may re-authenticate under it; a value captured once at
 * boot would go stale and every clone after that would fail with a credential the operator had already replaced.
 * It defaults to resolving nothing, which is what the read-only callers need and what every test gets for free.
 *
 * `identity` is a function for the same reason and with the same default, and it is here because `mergeBase` COMMITS.
 * It was missing, and the shape of the bug is worth writing down because the obvious diagnosis is not the whole of it.
 * `runEnv` drops the global and system config files deliberately, so a fresh `--filter=blob:none` clone has no
 * `user.name` or `user.email` anywhere git will look. What happens next depends on the machine:
 *
 *  - Where git can guess an identity from the passwd database (macOS, and any Linux box with a gecos field), the merge
 *    SUCCEEDS and commits as `<login>@<hostname>.local`. Nothing fails, and the daemon's merge commit is attributed to
 *    a machine-derived address that is not the operator's. That is the exact outcome lib/identity.mjs exists to prevent,
 *    arriving on the one commit the daemon makes itself rather than on a session's.
 *  - Where it cannot (a container, a CI runner, `user.useConfigOnly`), the merge fails with "Committer identity
 *    unknown". `mergeBaseInto` reports any such failure as `conflict: true`, so the operator is told their branch
 *    cannot be merged with its base and pointed at a conflict that does not exist, and every divergent-base fix round
 *    and every `resume` is blocked behind it.
 *
 * A null resolution stays legal rather than throwing, and that is the deliberate half. `originOf` and `currentBranch`
 * commit nothing, and refusing a read because the machine has no committer would be a worse bug than the one above.
 * The refusal belongs where a commit is actually being paid for: `requireIdentity` in `startRun` and in `start`, before
 * a session is spawned. So this resolver is allowed to answer nothing, and git decides what a commit without one means.
 */
export function makeGit({ config, exec = execFileAsync, credential = async () => null, identity = async () => null } = {}) {
  const env = async () => ({ ...process.env, ...runEnv(config, await credential(), await identity()) });
  const git = async (args, cwd, timeout = GIT_TIMEOUT_MS) => (await exec("git", args, { cwd, env: await env(), timeout })).stdout.trim();
  const gh = async (args, cwd, timeout = CLONE_TIMEOUT_MS) => (await exec("gh", args, { cwd, env: await env(), timeout })).stdout.trim();

  async function ensureHttpsRemote(dir) {
    const origin = await git(["remote", "get-url", "origin"], dir);
    const repo = repoFromRemote(origin);
    if (repo && !origin.startsWith("https://")) await git(["remote", "set-url", "origin", cloneUrl(repo)], dir);
  }

  /**
   * The `commit-msg` hook that refuses a commit message crediting an AI harness, written into a checkout's own
   * `.git/hooks`. Idempotent, and called on every path that hands a session a worktree, not only on the clone: a
   * checkout made before this existed, or one whose hooks directory an operator cleared, must get it on the next use
   * rather than staying unguarded until someone deletes it.
   *
   * `.git/hooks` is git's default, so nothing has to be configured and `runEnv` gains no path. See lib/attribution.mjs
   * for why not a directory inside the working tree.
   *
   * Never fatal. A hook that could not be written is a missing guard and not a reason to refuse a session the checkout
   * it needs, so the failure is returned and the caller logs it. The identity half of the guarantee (`user.name` and
   * `user.email` in `RUN_GIT_CONFIG`) does not depend on this file at all.
   */
  function installHooks(dir) {
    try {
      writeRepositoryText(dir, ".git/hooks/commit-msg", COMMIT_MSG_HOOK, { mode: 0o755, allowGit: true });
      return { installed: true };
    } catch (e) { return { installed: false, why: e.message }; }
  }

  return {
    containsCommit: async (dir, sha) => {
      try { await git(["merge-base", "--is-ancestor", sha, "HEAD"], dir); return true; }
      catch (e) { if (e.code === 1) return false; throw e; }
    },
    fileAt: async (dir, ref, path) => {
      const listing = await git(["ls-tree", "-z", ref, "--", path], dir);
      if (!listing) return null;
      if (!listing.startsWith("100644 blob ") && !listing.startsWith("100755 blob ")) throw new Error(`${path} at ${ref} is not a regular file`);
      // Keep final newlines: these bytes are compared with the approved source snapshot.
      return (await exec("git", ["show", `${ref}:${path}`], { cwd: dir, env: await env(), timeout: GIT_TIMEOUT_MS })).stdout;
    },
    installHooks,
    ensureHttpsRemote,
    /**
     * Fresh worktree on a new branch cut from `base` on the remote.
     *
     * `base` is whatever `resolveBase` decided (lib/config.mjs): the repository's configured base, or its default
     * branch when nothing configured one. It used to be `defaultBranch` and nothing else, which cut every branch from
     * the repository's default even for a project whose pull requests all target `staging`.
     *
     * The fetch is the reason the clone is not the whole of this. `gh repo clone --no-checkout` brings the remote's
     * refs as they are at clone time, which for a fresh directory is current; for one whose parent directory was left
     * behind by a previous run it is whatever git last saw. Fetching the base by name before cutting from it is what
     * makes "cut from the current base" true rather than nearly true, and it is the whole of what a rebase would have
     * done at `start`: a branch cut from the tip of its base has nothing to rebase onto.
     */
    async create({ nameWithOwner, prdId, base }) {
      const path = worktreePath(config, nameWithOwner, prdId);
      if (exists(join(path, ".git"))) throw new Error(`worktree already exists at ${path}`);
      ensureDir(join(path, ".."), 0o755);
      await gh(["repo", "clone", cloneUrl(nameWithOwner), path, "--", "--filter=blob:none", "--no-checkout"]);
      await git(["fetch", "origin", base], path);
      await git(["checkout", "-b", branchFor(prdId), `origin/${base}`], path);
      installHooks(path);
      return path;
    },
    /**
     * Bring `base` into the checked-out branch with a merge commit, before a session is handed the worktree.
     *
     * A MERGE and not a rebase, and this is the decision the whole change turns on. Three things in this codebase make
     * a rebase the wrong instrument, and none of them is a matter of taste:
     *
     *  - A rebase rewrites history, so the pushed branch can only move with `--force`. `lib/prompt.mjs`'s RULES tell
     *    every session "Do not force-push". A daemon that force-pushes while forbidding its sessions to is two rules,
     *    and the one an operator would find is the one that broke their branch.
     *  - `reviewerVerdict` (lib/events.mjs) clears a head only when the sha the reviewer named is a prefix of it. Every
     *    rewrite makes every prior clearance describe a commit that no longer exists, so a rebase between rounds
     *    silently costs a re-review cycle, and the reviewer's inline comments are anchored to those same shas.
     *  - The tick reads a head it did not put there as a human's push (`headChanged`): it resets the reviewer clock and
     *    un-nudges. A daemon force-push would look to the daemon itself like a stranger pushing.
     *
     * A merge has none of those. It moves the head forward, so the remote takes it without `--force`; every reviewed
     * commit stays an ancestor, so a clearance keeps describing something real; and the commit it adds is the daemon's
     * own, which is the honest record of what happened. The cost is a merge commit in the history, which is the
     * cheaper of the two prices.
     *
     * The merge is the daemon's, so `--no-ff` is explicit: a base that is already an ancestor is `{ merged: false }`
     * and nothing is committed, and anything else gets one commit that says what it brought in.
     *
     * Conflicts abort. A half-merged checkout with conflict markers handed to a session as if it were clean is the
     * worst thing this function could leave, so a failure runs `git merge --abort` and reports rather than throwing
     * something the caller has to guess at. `--abort` is itself allowed to fail (there may be nothing to abort) and
     * that failure is not allowed to hide the conflict.
     */
    async mergeBase(dir, base) {
      await git(["fetch", "origin", base], dir);
      const head = await git(["rev-parse", "HEAD"], dir);
      const baseSha = await git(["rev-parse", `origin/${base}`], dir);
      // Already up to date: the base's tip is an ancestor of this branch, so there is nothing to bring in and nothing
      // to record. `merge-base --is-ancestor` exits 0 for that and non-zero otherwise, which is what the throw means.
      try { await git(["merge-base", "--is-ancestor", baseSha, head], dir); return { merged: false, base, baseSha, head }; }
      catch { /* not an ancestor: there is something to merge */ }
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
      try {
        await git(["merge", "--no-ff", "--no-edit", "-m", `Merge origin/${base} into ${branch}`, `origin/${base}`], dir);
      } catch (e) {
        try { await git(["merge", "--abort"], dir); } catch { /* nothing to abort, or the abort itself failed; the conflict is what matters */ }
        return { merged: false, conflict: true, base, baseSha, head, why: e.message.split("\n").find(l => l.trim()) || `could not merge origin/${base}` };
      }
      return { merged: true, base, baseSha, head, sha: await git(["rev-parse", "HEAD"], dir) };
    },
    /**
     * Worktree for an existing PR branch, used by `register` and by recovery. Idempotent. When the directory
     * exists it must be a clone of the same repository on that branch; anything else is an error, never silently
     * reused.
     */
    async fromBranch({ nameWithOwner, prdId, branch, path = worktreePath(config, nameWithOwner, prdId) }) {
      if (exists(join(path, ".git"))) {
        const origin = await git(["remote", "get-url", "origin"], path);
        // Exact owner/repo, never a substring: `acme/widget-fork` is not `acme/widget`.
        if (!remoteMatches(origin, nameWithOwner)) throw new Error(`${path} is a clone of ${origin}, not ${nameWithOwner}`);
        await ensureHttpsRemote(path);
        await git(["fetch", "origin", branch], path);
        await git(["checkout", branch], path);
        installHooks(path);
        return path;
      }
      ensureDir(join(path, ".."), 0o755);
      await gh(["repo", "clone", cloneUrl(nameWithOwner), path, "--", "--filter=blob:none", "--branch", branch]);
      installHooks(path);
      return path;
    },
    exists: path => exists(join(path, ".git")),
    toplevel: dir => git(["rev-parse", "--show-toplevel"], dir),
    /**
     * Commits on the checked-out branch that the remote does not have, newest first, as `{ sha, subject }`.
     *
     * This is what `resume` tells a session so it does not spend a round rediscovering its own work. The real case:
     * a run implemented a brief, made four commits, could not push, and stopped. Resumed, the session's memory ends
     * mid-task and it cannot tell "I committed this" from "I was about to"; without being told, the cheapest thing it
     * can do is re-derive the state by reading the diff, which costs a round and risks it redoing finished work.
     *
     * Two ranges, and the second is the one that matters. `origin/<branch>..HEAD` is right for a branch that has been
     * pushed before and has moved since. But the case this exists for is a branch that was NEVER pushed, and there
     * `origin/<branch>` does not exist: git errors, or worse, an older git reports nothing and the whole paragraph
     * silently goes missing for exactly the run it was written for. Verified against the real stranded branch, where
     * the first range found nothing and the second found all four commits. So a missing remote branch falls back to
     * `origin/<base>..HEAD`, which is every commit the branch has added since it was cut.
     *
     * Empty on any failure, and deliberately so. A detached HEAD, a checkout whose refs are not fetched, no remote at
     * all: none is worth failing a resume over, and the prompt omits the paragraph rather than asserting something it
     * could not confirm.
     */
    async unpushed(dir, branch, base = null) {
      const parse = out => (out ? out.split("\n").filter(Boolean).map(l => { const [sha, ...rest] = l.split(" "); return { sha, subject: rest.join(" ") }; }) : []);
      const range = async r => { try { return parse(await git(["log", "--oneline", "--no-decorate", r], dir)); } catch { return null; } };
      // Does the remote even have this branch? `rev-parse --verify` answers without a network round trip.
      const hasRemote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], dir).then(o => !!o).catch(() => false);
      if (hasRemote) return (await range(`origin/${branch}..HEAD`)) ?? [];
      // Never pushed. Everything since the base is unpushed by definition. `origin/HEAD` covers the common case where
      // no base was passed; it is a symbolic ref to the remote's default branch.
      for (const r of [base && `origin/${base}..HEAD`, "origin/HEAD..HEAD"].filter(Boolean)) {
        const found = await range(r);
        if (found?.length) return found;
      }
      return [];
    },
    /**
     * Uncommitted work in a checkout, as { modified, untracked }. Counts only; no paths, because the caller records this
     * in the registry and a file list there would grow without bound and carry the operator's filenames into state.
     *
     * This exists because `unpushed` does not cover the case that loses work. A run was SIGKILLed at 31.2 minutes having
     * done a full review round and written its commit message to a temp file, one tool call before `git commit`. Nothing
     * was committed, so `unpushed` counted zero and every signal said the entry simply timed out, while the worktree held
     * six modified and four untracked files that no commit, branch or PR contained. Uncommitted is strictly more fragile
     * than unpushed: `resume` recreates a missing checkout without asking, and a `git clean` takes it, either of which
     * destroys the round in silence.
     *
     * `--porcelain` because its format is a stability guarantee and `-uall` so an untracked DIRECTORY is counted as its
     * files rather than one line; the untracked half is what a recreate would take with no trace.
     *
     * Zeroes on any failure, like `unpushed`: this is reporting, and a checkout that has gone missing is not worth
     * failing a kill over. `{ modified: 0, untracked: 0 }` reads as "nothing to report", which is also the honest answer
     * when the directory is gone, and the caller has the worktree path on screen either way.
     */
    async dirty(dir, { strict = false } = {}) {
      let out;
      try { out = await git(["status", "--porcelain", "-uall"], dir); }
      catch (error) { if (strict) throw error; return { modified: 0, untracked: 0 }; }
      let modified = 0, untracked = 0;
      for (const line of (out || "").split("\n")) {
        if (!line.trim()) continue;
        if (line.startsWith("??")) untracked++;
        else modified++;
      }
      return { modified, untracked };
    },
    /** The `origin` remote URL of a checkout, as git stores it. */
    originOf: dir => git(["remote", "get-url", "origin"], dir),
    /** The checked-out branch name, or "HEAD" when the checkout is detached. */
    currentBranch: dir => git(["rev-parse", "--abbrev-ref", "HEAD"], dir),
  };
}
