import { remoteInput } from "./execution_input.mjs";
import { makeCloudTransport } from "./codex_cloud.mjs";
import { contentHash } from "./openai_agents_sources.mjs";
// Builds the real dependencies once for the CLI. Tests build their own with fakes; nothing else imports this.
import { join } from "node:path";
import { load as loadConfig } from "./config.mjs";
import { makeState, idSlug } from "./state.mjs";
import { makeHostRegistry } from "./hosts.mjs";
import { makeGit } from "./git.mjs";
import { repositoryIdentity } from "./repository.mjs";
import { resolveIdentity } from "./identity.mjs";
import { makeNotifier } from "./notify.mjs";
import { makeLog } from "./log.mjs";
import { makeRunner } from "./run.mjs";
import { ensureDir, gallivantHome, readText, writeText } from "./fs.mjs";
import { aportDirFor, guardrailMode } from "./aport.mjs";
import { makeExecution, executionEpoch, assertExecutionDependency } from "./execution.mjs";
import { makeAgentsTransport } from "./openai_agents.mjs";
import { capabilitiesFor } from "./harness.mjs";
import { createLearningService } from "./learning.mjs";
import { makeTrust } from "./events.mjs";
import { revokeLearningAttempts } from "./learning_input.mjs";
import { createReviewService } from "./first_party_review.mjs";
import { silentLog } from "./log.mjs";
import { cleanupMergedWorkspace, maintainWorkspace } from "./workspace_cleanup.mjs";
import { createCollaborationStore } from "./collaboration_store.mjs";
import { createBoardCollaborationAdapter } from "./board_collaboration.mjs";
import { createCollaborationService, withCollaborationState } from "./collaboration.mjs";
import { makeRecoveryCooldowns } from "./recovery_cooldown.mjs";
import { makePackageAuthPreflight } from "./package_auth.mjs";
import { makeJournalReserve, requireHeadroom, resourceSettings } from "./recovery_resources.mjs";
import { makeLocalPlans } from "./local_plan_service.mjs";
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

export function makeContext({ home = gallivantHome(), needConfig = true, readOnly = false, rawConfig } = {}) {
  assertExecutionDependency(createTaskService);
  if (!readOnly) ensureDir(home, 0o700);
  const log = readOnly ? silentLog : makeLog(home);
  if (!needConfig) return { home, log };
  const config = loadConfig(home, { raw: rawConfig });
  // Each adapter resolves its credentials per operation, so reauthentication is
  // picked up without restarting the coordinator or sharing another host's token.
  const cooldowns = readOnly ? null : makeRecoveryCooldowns({ home });
  const hosts = makeHostRegistry({ config, log, cooldowns });
  const credential = (opts = {}) => hosts.credential(repositoryIdentity(opts.path ?? opts.repository ?? opts.repo ?? "owner/name", opts.host));
  // The git identity a run commits as, resolved the same way and for the same reason: per call, so an operator who
  // changes their name or email under a long-lived daemon is committed as who they are now.
  const identity = () => resolveIdentity();
  const host = hosts.api;
  const gh = hosts.select("owner/name").api;
  const state = makeState(home);
  const context = {
    home, log, config, host, hosts, gh, credential, identity, cooldowns,
    packageAuthPreflight: makePackageAuthPreflight({ cooldowns }),
    state, capabilitiesFor,
    executionInputFor: (id, entry, input, contextPaths) => remoteInput(context, id, entry, input, contextPaths),
    notify: makeNotifier({ config, log }),
    runnerFor: id => runnerFor(id, state.get(id)?.harness),
    executionFor: (id, provider) => {
      const root = join(home, "runs", idSlug(id)), selected = config.harness[provider];
      const account = selected?.account || "operator";
      const entry = state.get(id), runner = capabilitiesFor(provider).transport === "remote" ? null : runnerFor(id, provider);
      const epoch = executionEpoch({ root, taskId: id, entry, provider, account, runner });
      return makeExecution({ root, taskId: id, provider, account, ledgerEpoch: epoch, ledgerFile: join(root, epoch ? `execution-${epoch}.json` : "execution.json"),
        ...(provider === "openai-agents" ? { transport: makeAgentsTransport({ root, taskId: id, account, config: selected }), capabilities: { ...capabilitiesFor(provider), models: [selected?.model] } } : {}),
        ...(provider === "codex-cloud" ? { transport: makeCloudTransport({ root, taskId: id, account, config: selected, verifyRemote: async input => {
          if (await host.refSha(input.repo, input.sources.inputBranch) !== input.inputHead || await host.refSha(input.repo, input.branch) !== input.inputHead) throw new Error("Cloud remote input revision moved; reconcile before dispatch");
          for (const [path, hash] of Object.entries(input.sources.hashes)) {
            if (contentHash(await host.fileAtStrict(input.repo, path, input.inputHead)) !== hash) throw new Error("Cloud remote snapshot hash differs");
          }
        } }), capabilities: { ...capabilitiesFor(provider), environments: [selected?.environment] } } : {}),
        legacySessionId: state.get(id)?.harness === provider ? state.get(id).session : null,
        runner, limits: config.execution, cooldowns });
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
  const localPlans = context.localPlans = makeLocalPlans(context);
  if (localPlans.enabled) context.planOperatorForRequest = localPlans.operatorForRequest;
  // Base merges and other coordinator commits retain their configured identity
  // when Git itself has to run under the checkout's worker account.
  context.git = makeGit({ config, identity, hosts, worktreeBoundary: localPlans.gitBoundary });
  const runnerFor = (id, provider) => makeRunner(join(home, "runs", idSlug(id)), {
    launch: (cmd, args, options) => localPlans.authorLaunch(provider, state.get(id), cmd, args, options),
  });
  if (config.collaboration) {
    const collaborationStore = createCollaborationStore(home);
    context.collaboration = createCollaborationService({
      adapter: createBoardCollaborationAdapter(config.collaboration, { clock: context.clock || Date }),
      store: collaborationStore, config: config.collaboration, log, clock: context.clock || Date,
    });
    context.state = withCollaborationState(state, context.collaboration, log);
  }
  const learningServices = new Map();
  context.learningFor = (ownLogin = "learning-coordinator", { signerExecutable } = {}) => {
    const cacheKey = JSON.stringify([ownLogin, signerExecutable ?? null]);
    if (!learningServices.has(cacheKey)) {
      const service = createLearningService({
        root: join(home, "learning"), signerExecutable, gh, trust: makeTrust(config, ownLogin),
        onRevocation: intent => revokeLearningAttempts(context, intent),
      });
      learningServices.set(cacheKey, { ...service,
        identityFor: name => hosts.select(name).adapter.features?.learning ? service.identityFor(name) : null,
      });
    }
    return learningServices.get(cacheKey);
  };
  if (!readOnly) {
    const resources = resourceSettings(config);
    context.resourcePreflight = (worktree, planned = false) => requireHeadroom({ stateDir: home, worktree, planned }, resources);
    context.outputNextAtFor = id => context.runnerFor(id).outputNextAt();
    if (resources.journal_reserve) {
      context.journalReserve = makeJournalReserve(home, resources.journal_reserve);
      context.provisionResourceReserve = () => context.journalReserve.provision(resources);
    }
    context.reviewService = createReviewService(context);
    context.cleanupMergedWorkspace = (id, entry, pr, authority) => cleanupMergedWorkspace({ ...context, ...authority }, id, entry, pr);
    context.maintainWorkspace = (id, entry, authority) => maintainWorkspace({ ...context, ...authority }, id, entry);
  }
  return context;
}
