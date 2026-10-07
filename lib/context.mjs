import { remoteInput } from "./execution_input.mjs";
import { makeCloudTransport } from "./codex_cloud.mjs";
import { contentHash } from "./openai_agents_sources.mjs";
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
import { makeAgentsTransport } from "./openai_agents.mjs";
import { capabilitiesFor } from "./harness.mjs";
import { createLearningService } from "./learning.mjs";
import { makeTrust } from "./events.mjs";
import { revokeLearningAttempts } from "./learning_input.mjs";
import { silentLog } from "./log.mjs";
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

export function makeContext({ home = gallivantHome(), needConfig = true, readOnly = false } = {}) {
  assertExecutionDependency(createTaskService);
  if (!readOnly) ensureDir(home, 0o700);
  const log = readOnly ? silentLog : makeLog(home);
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
  const context = {
    home, log, config, gh, credential, identity,
    state, capabilitiesFor,
    executionInputFor: (id, entry, input, contextPaths) => remoteInput(context, id, entry, input, contextPaths),
    // `identity` as well as `credential`, because `git.mergeBase` commits: the merge that brings a base into a branch
    // is the daemon's own commit, and with no identity pairs it is either attributed to a machine-derived address or
    // refused outright, depending on whether the host's git can guess one. See makeGit for the two shapes.
    git: makeGit({ config, credential, identity }),
    notify: makeNotifier({ config, log }),
    runnerFor: id => makeRunner(join(home, "runs", idSlug(id))),
    executionFor: (id, provider) => {
      const root = join(home, "runs", idSlug(id)), selected = config.harness[provider];
      const account = selected?.account || "operator";
      return makeExecution({ root, taskId: id, provider, account,
        ...(provider === "openai-agents" ? { transport: makeAgentsTransport({ root, taskId: id, account, config: selected }), capabilities: { ...capabilitiesFor(provider), models: [selected?.model] } } : {}),
        ...(provider === "codex-cloud" ? { transport: makeCloudTransport({ root, taskId: id, account, config: selected, verifyRemote: async input => {
          if (await gh.refSha(input.repo, input.sources.inputBranch) !== input.inputHead || await gh.refSha(input.repo, input.branch) !== input.inputHead) throw new Error("Cloud remote input revision moved; reconcile before dispatch");
          for (const [path, hash] of Object.entries(input.sources.hashes)) {
            if (contentHash(await gh.fileAtStrict(input.repo, path, input.inputHead)) !== hash) throw new Error("Cloud remote snapshot hash differs");
          }
        } }), capabilities: { ...capabilitiesFor(provider), environments: [selected?.environment] } } : {}),
        legacySessionId: state.get(id)?.harness === provider ? state.get(id).session : null,
        runner: capabilitiesFor(provider).transport === "remote" ? null : makeRunner(root), limits: config.execution });
    },
    // The APort API key the Claude install recorded, if any, so hosted gate calls count against the same account.
    aportApiKey: guardrailMode(aportDirFor(config.harness?.claude?.settings)).apiKey,
    readPrd: id => readText(prdSnapshotPath(home, id)),
    writePrd: (id, text) => writeText(prdSnapshotPath(home, id), text),
    // The carried files, read and written one at a time so the caller decides what a missing one means. They are
    // daemon state, not files in a source tree, so they take writeText's default 0o600 like the brief's snapshot does.
    readSource: (id, rel) => readText(sourceSnapshotPath(home, id, rel)),
    writeSource: (id, rel, text) => writeText(sourceSnapshotPath(home, id, rel), text),
  };
  const learningServices = new Map();
  context.learningFor = (ownLogin = "learning-coordinator") => {
    if (!learningServices.has(ownLogin)) learningServices.set(ownLogin, createLearningService({
      root: join(home, "learning"), gh, trust: makeTrust(config, ownLogin),
      onRevocation: intent => revokeLearningAttempts(context, intent),
    }));
    return learningServices.get(ownLogin);
  };
  return context;
}
