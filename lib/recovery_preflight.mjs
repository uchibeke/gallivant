import { accessSync, constants, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateRecoveryProfile, recoveryScopes } from "./recovery_authority.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { contentDigest, sourceManifestDigest } from "./start_contract.mjs";
import { readRepositoryText } from "./repository_files.mjs";
import { publicationPolicyOf } from "./work_artifacts.mjs";
import { resolveContextPaths } from "./config.mjs";

const changed = detail => { throw Object.assign(new Error(`Approved ${detail} changed during turn preparation. Inspect the saved revision before dispatch.`), { code: "RECOVERY_BINDING" }); };

export function authorRouteDigest(config, harness, prd) {
  const h = config.harness[harness] ?? {};
  return digest([harness, h.bin, h.provider, h.account, h.model, h.environment, h.repository,
    h.data_location, h.credential_ref, h.settings, h.mandatory_policy, resolveContextPaths(config, prd)]);
}

// Both the pre-clone check and the launch boundary read the coordinator's store.
export function approvedSnapshotDigests(ctx, id, entry, prd) {
  if (typeof ctx.readPrd !== "function") throw Object.assign(new Error("Restore the coordinator's approved brief snapshot reader before starting a turn."), { code: "RECOVERY_BINDING" });
  const text = ctx.readPrd(id) ?? null;
  const brief = contentDigest(text);
  if ((prd?.text ?? null) !== text || entry.snapshot_digest && brief !== entry.snapshot_digest) changed("brief snapshot");
  const sources = (entry.sources || []).map(path => {
    const bytes = ctx.readSource?.(id, path) ?? null;
    if (bytes == null && (entry.snapshot_digest || entry.sources_digest || entry.recovery_profile)) changed("source snapshot");
    return [path, bytes];
  });
  const sourceDigest = sourceManifestDigest(sources);
  if (entry.sources_digest && entry.sources_digest !== sourceDigest) changed("source manifest");
  return { brief, sources: sourceDigest };
}

export function turnBinding(ctx, id, entry, prd) {
  const snapshots = approvedSnapshotDigests(ctx, id, entry, prd);
  const route = authorRouteDigest(ctx.config, entry.harness, prd);
  if (entry.author_route_digest && entry.author_route_digest !== route) changed("author route or context");
  let generations = [];
  if (entry.recovery_profile) {
    const admin = ctx.state.load().recovery;
    const saved = admin?.profiles.find(profile => profile.digest === entry.recovery_profile.digest);
    if (!saved || admin.version !== 1 || entry.recovery_profile.version !== 1 || saved.storeId !== admin.storeId) changed("protected recovery profile");
    validateRecoveryProfile(saved);
    generations = recoveryScopes(id, entry, saved).map(scope => admin.holds[scope] ?? null);
    if (generations.some(hold => hold && hold.active !== false)) changed("recovery hold");
  }
  return digest({ generations, ...snapshots, route, profile: entry.recovery_profile ?? null,
    policy: publicationPolicyOf(prd, { base: entry.base, sources: entry.sources }), task: entry.task?.revision,
    repo: entry.repo, base: entry.base, branch: entry.branch, worktree: entry.worktree });
}

// A profile-bound author may read its checkout as part of a prompt. Compare
// the actual private overlays immediately before launch, preserving any edits.
export function verifyAuthorCopies(ctx, id, entry, prd) {
  if (!entry.recovery_profile) return;
  const policy = publicationPolicyOf(prd, { sources: entry.sources });
  for (const path of [entry.prd, ...policy.inputFiles.filter(path => !policy.publishFiles.includes(path))].filter(Boolean)) {
    const approved = path === entry.prd ? ctx.readPrd(id) : ctx.readSource(id, path);
    if (readRepositoryText(entry.worktree, path) !== approved) changed("checkout copy of " + path);
  }
}

export function checkAuthorStorage({ stateDir, worktree, gitDirs, scratch = tmpdir() }, { statfs = statfsSync, access = accessSync } = {}) {
  for (const [kind, path] of [["state", stateDir], ["checkout", worktree], ["scratch", scratch], ...gitDirs.map(path => ["Git metadata", path])]) {
    try {
      access(path, constants.W_OK | constants.X_OK);
      const fs = statfs(path, { bigint: true });
      if (fs.bavail * fs.bsize < 1048576n || fs.ffree < 16n) throw new Error();
    } catch {
      throw Object.assign(new Error(`Author preflight requires a writable ${kind} mount with at least 1 MiB and 16 free inodes. Restore access or space on that mount before dispatch.`), { code: "AUTHOR_STORAGE" });
    }
  }
}

// Only protected coordinator evidence from the selected owner is supplied
// here. Its scope includes the whole tuple, package selection and repository.
const remedies = Object.freeze({
  route: "Supply execution-owner proof of the exact provider, credential reference, environment, data location, capabilities and spending ceiling for this route.",
  host: "Restore host, repository write and pull request access for the selected account.",
  model: "Confirm entitlement to the exact configured harness, model and account.",
  runtime: "Restore the approved tool and runtime versions.",
  packages: "Restore read access for the explicitly selected packages.",
  browser: "Provide the required browser or capture surface inside the selected adapter.",
  privateContext: "Provide an approved private transport compatible with this route.",
  storage: "Check Git metadata permissions and free bytes and inodes on state, checkout and scratch mounts.",
});
export function authorReadiness({ repo, route, packages = [], browser = false, privateContext = false }, evidence = {}, now = Date.now()) {
  const binding = digest({ repo, route, packages, browser, privateContext });
  const required = ["route", "host", "model", "runtime", "storage", ...(packages.length ? ["packages"] : []),
    ...(browser ? ["browser"] : []), ...(privateContext ? ["privateContext"] : [])];
  const missing = required.filter(key => {
    const proof = evidence[key];
    return proof?.binding !== binding || proof.ok !== true || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= now;
  });
  return { binding, ready: !missing.length, diagnostics: missing.map(check => ({ check, remedy: remedies[check] })) };
}
