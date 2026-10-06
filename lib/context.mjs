// Builds the real dependencies once for the CLI. Tests build their own with fakes; nothing else imports this.
import { join } from "node:path";
import { load as loadConfig } from "./config.mjs";
import { makeState, idSlug } from "./state.mjs";
import { makeGh } from "./gh.mjs";
import { makeGit } from "./git.mjs";
import { resolveCredential } from "./credential.mjs";
import { resolveIdentity } from "./identity.mjs";
import { makeNotifier } from "./notify.mjs";
import { makeLog } from "./log.mjs";
import { makeRunner } from "./run.mjs";
import { ensureDir, gallivantHome, readText, writeText } from "./fs.mjs";
import { aportDirFor, guardrailMode } from "./aport.mjs";
import { makeExecution, assertExecutionDependency } from "./execution.mjs";
import { capabilitiesFor } from "./harness.mjs";
const { createTaskService } = await import("./tasks.mjs").catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") assertExecutionDependency(null);
  throw error;
});

/** Where the daemon keeps its own copy of each PRD, taken at start, so a session cannot rewrite its brief. */
export const prdSnapshotPath = (home, id) => join(home, "prds", `${idSlug(id)}.md`);

/**
 * Where a carried file's snapshot lives: one directory per entry, beside the brief's own snapshot and named the same
 * way. The relative path is kept inside that directory, so `docs/a.md` and `a.md` are two files rather than one and a
 * carried file lands back at the path the brief named.
 */
export const sourceSnapshotPath = (home, id, rel) => join(home, "prds", `${idSlug(id)}.sources`, rel);

export function makeContext({ home = gallivantHome(), needConfig = true } = {}) {
  assertExecutionDependency(createTaskService);
  ensureDir(home, 0o700);
  const log = makeLog(home);
  if (!needConfig) return { home, log };
  const config = loadConfig(home);
  // One credential resolver for the whole process, shared by `gh` and `git` so both act as the same identity.
  //
  // Per call, not per boot. It costs one `gh auth token` subprocess (only when neither the config file nor the
  // daemon's own environment answers, which are both free), and it is the only way an operator who re-authenticates
  // under a long-lived daemon gets the new token without restarting it. A value cached at boot would expire under
  // exactly the daemon this product is built around.
  const credential = (opts = {}) => resolveCredential(config, opts);
  // The git identity a run commits as, resolved the same way and for the same reason: per call, so an operator who
  // changes their name or email under a long-lived daemon is committed as who they are now.
  const identity = () => resolveIdentity();
  const gh = makeGh({ credential, log });
  const state = makeState(home);
  return {
    home, log, config, gh, credential, identity,
    state, capabilitiesFor,
    // `identity` as well as `credential`, because `git.mergeBase` commits: the merge that brings a base into a branch
    // is the daemon's own commit, and with no identity pairs it is either attributed to a machine-derived address or
    // refused outright, depending on whether the host's git can guess one. See makeGit for the two shapes.
    git: makeGit({ config, credential, identity }),
    notify: makeNotifier({ config, log }),
    runnerFor: id => makeRunner(join(home, "runs", idSlug(id))),
    executionFor: (id, provider) => makeExecution({ root: join(home, "runs", idSlug(id)), taskId: id, provider, account: config.harness[provider]?.account || "operator", legacySessionId: state.get(id)?.harness === provider ? state.get(id).session : null, runner: makeRunner(join(home, "runs", idSlug(id))), limits: config.execution }),
    // The APort API key the Claude install recorded, if any, so hosted gate calls count against the same account.
    aportApiKey: guardrailMode(aportDirFor(config.harness?.claude?.settings)).apiKey,
    readPrd: id => readText(prdSnapshotPath(home, id)),
    writePrd: (id, text) => writeText(prdSnapshotPath(home, id), text),
    // The carried files, read and written one at a time so the caller decides what a missing one means. They are
    // daemon state, not files in a source tree, so they take writeText's default 0o600 like the brief's snapshot does.
    readSource: (id, rel) => readText(sourceSnapshotPath(home, id, rel)),
    writeSource: (id, rel, text) => writeText(sourceSnapshotPath(home, id, rel), text),
  };
}
