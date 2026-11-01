import { HOST_DEFINITIONS } from "./host_definitions.mjs";
import { github } from "./hosts/github.mjs";
import { bitbucket } from "./hosts/bitbucket.mjs";
import { repositoryIdentity, parseRemote, parsePullRequestUrl, savedRepository } from "./repository.mjs";
import { requireHostCapabilities, completeItems, validateHostRecord, MAX_DIFF_BYTES } from "./host_contract.mjs";
import { execFileAsync } from "./process.mjs";

const IMPLEMENTATIONS = { [github.id]: github, [bitbucket.id]: bitbucket };
const DEFAULT_ADAPTERS = HOST_DEFINITIONS.map(definition => ({ ...definition, ...IMPLEMENTATIONS[definition.id] }));

const METHODS = ["branchExists", "repoDefaultBranch", "repoPermissions", "refSha", "containsCommit", "fileAt", "fileAtStrict", "commitDate",
  "prView", "prDiff", "reviewEvidence", "prListMine", "prListByHead", "reviews", "inlineComments", "issueComments", "comment", "setBody", "setTitle", "setRecoveryMetadata", "markReady",
  "addLabel", "removeLabel", "ensureLabels"];
const LISTS = new Set(["prListMine", "prListByHead", "reviews", "inlineComments", "issueComments"]);
const DECORATIONS = new Set(["addLabel", "removeLabel", "ensureLabels"]);

/** Static, injectable registry. Only GitHub is qualified in the shipped registry. */
export function makeHostRegistry({ adapters = DEFAULT_ADAPTERS, config = {}, credential, exec, log, fetch, limits } = {}) {
  const definitions = new Map(adapters.map(a => [a.host, a]));
  if (definitions.size !== adapters.length) throw new Error("Duplicate host registration");
  const instances = new Map();
  function select(value, { transport = false } = {}) {
    const repository = typeof value === "object" && value.repo ? savedRepository(value) : repositoryIdentity(value);
    const adapter = definitions.get(repository.host);
    if (!adapter) throw new Error(`Unsupported repository host ${repository.host}; this release has no qualified adapter. Use a supported checkout before init, doctor, start or register.`);
    if (!transport) {
      if (adapter.dispatch === false) throw new Error(adapter.dispatchReason);
      requireHostCapabilities(adapter);
    }
    if (value?.repo && value.url) {
      const target = adapter.parsePr(value.url);
      if (!target || repositoryIdentity(target.repo).remoteIdentity !== repository.remoteIdentity || (value.pr != null && target.number !== value.pr)) throw new Error("Ambiguous saved PR identity; back up state and reconcile its repository, URL and PR number before retrying. Do not redispatch.");
    }
    if (!instances.has(repository.remoteIdentity)) instances.set(repository.remoteIdentity, adapter.create({ config, exec, log, fetch, limits, credential: async options => {
      const resolved = await (credential ? credential({ ...options, ...repository }) : adapter.credential(config, { ...options, ...repository }));
      if (!resolved?.token) throw Object.assign(new Error(resolved?.why || "Host API authorization is missing; a Git SSH key cannot authorize API operations"), { code: "NO_CREDENTIAL" });
      if (resolved.host && resolved.host !== adapter.host || resolved.repository && resolved.repository !== repository.path) throw new Error("API credential host/repository mismatch");
      return resolved;
    } }));
    return { repository, adapter, api: instances.get(repository.remoteIdentity) };
  }
  const inspect = value => select(value, { transport: true });
  const registry = {
    select, inspect,
    fromRemote: url => select(parseRemote(url)),
    inspectRemote: url => {
      const remote = parseRemote(url), selected = inspect(remote);
      if (remote.host !== "github.com" && !["https", "ssh"].includes(remote.transport)) throw new Error("Unsupported repository transport; use HTTPS or SSH");
      return selected;
    },
    fromUrl: (url, options) => {
      const envelope = parsePullRequestUrl(url), adapter = definitions.get(envelope.host);
      if (!adapter) throw new Error(`Unsupported repository host ${envelope.host}; no qualified PR adapter is installed`);
      const parsed = adapter.parsePr(url);
      if (!parsed) throw new Error("Invalid pull request URL; use its canonical qualified URL");
      return { ...select(parsed.repo, options), number: parsed.number };
    },
    credential: async value => {
      const { repository, adapter } = select(value);
      const resolved = credential ? await credential(repository) : await adapter.credential(config, repository);
      if (resolved?.host && resolved.host !== repository.host || resolved?.repository && resolved.repository !== repository.path) throw new Error("Credential host mismatch; restore the explicitly bound credential");
      return { ...resolved, host: repository.host, repository: repository.path };
    },
    gitCredential: async value => {
      const { repository, adapter } = inspect(value);
      const resolved = credential ? await credential({ ...repository, operation: "git" }) : await adapter.credential(config, { ...repository, operation: "git" });
      if (resolved?.host && resolved.host !== repository.host || resolved?.repository && resolved.repository !== repository.path) throw new Error("Git credential host/repository mismatch");
      return { ...resolved, host: repository.host, repository: repository.path };
    },
    remote: value => {
      const { repository, adapter } = inspect(value), remote = adapter.remote(repository, config);
      if (parseRemote(remote.url).remoteIdentity !== repository.remoteIdentity || parseRemote(remote.url).url !== remote.url || remote.host !== repository.host || remote.path !== repository.path) throw new Error("Adapter remote identity mismatch");
      return remote;
    },
  };
  const api = Object.fromEntries(METHODS.map(method => [method, async (repo, ...args) => {
    const selected = inspect(repo);
    if (DECORATIONS.has(method) && !selected.adapter.capabilities.labels) return;
    if (typeof selected.api[method] !== "function") throw new Error(`Required host operation ${method} is unavailable; preserve state and recover host access`);
    const value = await selected.api[method](selected.repository.path, ...args);
    if (LISTS.has(method)) {
      const items = completeItems(value, method);
      for (const item of items) validateHostRecord(item, selected.repository.host, { pr: method.startsWith("prList"), event: !method.startsWith("prList") });
      if (method === "prListByHead" && items.filter(pr => !pr.isCrossRepository).length > 1) throw new Error("Ambiguous PR ownership for the saved branch; reconcile its open PRs before retrying. Do not redispatch.");
      if (method.startsWith("prList")) for (const pr of items) {
        const target = registry.fromUrl(pr.url, { transport: true });
        if (target.repository.remoteIdentity !== selected.repository.remoteIdentity || target.number !== pr.number) throw new Error("PR list identity mismatch; preserve recovery state");
      }
      return items;
    }
    if (method === "prView" || method === "setRecoveryMetadata") {
      validateHostRecord(value, selected.repository.host, { pr: true, full: true });
      const target = registry.fromUrl(value?.url, { transport: true });
      if (target.repository.remoteIdentity !== selected.repository.remoteIdentity || target.number !== args[0] || value.number !== args[0]) throw new Error("PR response identity mismatch; preserve state and reconcile the saved PR");
    }
    if (method === "prDiff" && (typeof value !== "string" || Buffer.byteLength(value) >= MAX_DIFF_BYTES)) throw new Error("Unreadable or incomplete host diff");
    return value;
  }]));
  Object.assign(api, {
    user: options => select(config.repos?.[0]?.repo ?? config.repos?.[0] ?? repositoryIdentity("owner/name", adapters[0].host)).api.user(options),
    userFor: (repo, options) => select(repo).api.user(options),
    repoInfo: async dir => {
      const origin = (await (exec ?? execFileAsync)("git", ["remote", "get-url", "origin"], { cwd: dir })).stdout.trim();
      const { repository, api: selected } = registry.inspectRemote(origin);
      const info = await selected.repoInfo(dir, repository.path);
      if (repositoryIdentity(info.nameWithOwner, repository.host).remoteIdentity !== repository.remoteIdentity) throw new Error("Checkout and API repository identities differ; restore origin before dispatch");
      return { ...info, nameWithOwner: repository.key, repository: info.repository ?? repository };
    },
    publishResultPr: async options => {
      const { repository, api: selected } = inspect(options.repo);
      const result = await selected.publishResultPr({ ...options, repo: repository.path });
      const target = registry.fromUrl(result?.url, { transport: true });
      if (target.repository.remoteIdentity !== repository.remoteIdentity || target.number !== result.number) throw new Error("Published PR identity mismatch; reconcile before retrying");
      return result;
    },
  });
  return { ...registry, api };
}

export const hosts = makeHostRegistry();
// gh is a compatibility injection seam for old integrations and offline fixtures only.
export const hostApi = ctx => ctx.host ?? ctx.hosts?.api ?? ctx.gh;
export const repoFromUrl = url => { try { const found = hosts.fromUrl(url); return { repo: found.repository.key, number: found.number }; } catch { return null; } };
export const hostPrompts = repo => hosts.select(repo || "owner/name").adapter.prompts;
export const completionAdapter = (repo, registry = hosts) => registry.select(repo || "owner/name").adapter.id;

export function pullRequestUrl(repo, number, registry = hosts) {
  if (!Number.isSafeInteger(Number(number)) || Number(number) < 1) return null;
  try { const { adapter, repository } = registry.inspect(repo); return adapter.prUrl(repository, Number(number)); } catch { return null; }
}
