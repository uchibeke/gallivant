import { lstatSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { isPlanDigest as artifactHash } from "../dependency_plan_approval.mjs";
import { repoNames } from "../config.mjs";
import { canReadPlan, legacyPlan, scopeGrants } from "../dependency_plan_anchors.mjs";
import { isPlanManifest } from "../dependency_plan_sources.mjs";
import { PLAN_LIMITS } from "../dependency_plan_limits.mjs";
import { findSavedPlanReview, isPlanReviewId, reviewFilesAllowed, selectPlanControl } from "../dependency_plan_registry.mjs";
import { linearNodeId } from "../dependency_plan_linear.mjs";
import { redact } from "../execution_io.mjs";
import { contentDigest } from "../hash.mjs";
import { parseFrontmatter, parsePrd, sourcePathsOf } from "../prd.mjs";
import { pinRepositoryRoot, readPinnedRepositoryFile } from "../repository_files.mjs";
import { captureStartInput, sourceManifestDigest } from "../start_contract.mjs";
import { prdSnapshotPath, sourceSnapshotPath } from "../task_snapshots.mjs";
import { PRIVATE_PATH } from "../task_repository_context.mjs";
import { taskRoot, taskStore } from "../task_store.mjs";
import { approvalFilesRef, artifactKey, artifactRef, artifactReference, chainFilesRef, intakeBriefRef, planFilesRef, taskBriefRef } from "./artifact_links.mjs";
import { artifactMarkdown } from "./artifact_markdown.mjs";
import { factoryNote } from "./factory_projection.mjs";

const cap = PLAN_LIMITS.sourceBytes;
const binaryExtensions = /\.(?:avif|bmp|docx?|gif|heic|ico|jpe?g|mp[34]|od[st]|pdf|png|pptx?|tar|tiff?|wav|web[pma]|xlsx?|zip)$/i;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const availablePath = path => typeof path === "string" && Buffer.byteLength(path) <= PLAN_LIMITS.pathBytes
  && !/[\p{Cc}\p{Cf}:\\]/u.test(path) && path.split("/").every(part => part && part !== "." && part !== "..")
  && !PRIVATE_PATH.test(path) && !/(?:^|\/)(?:netrc|kubeconfig|htpasswd|auth\.json|tokens?|passwords?)(?:\.|\/|$)/i.test(path);
const disk = (root, path) => readPinnedRepositoryFile(pinRepositoryRoot(root), path, cap).bytes;
const stateError = state => Object.assign(new Error(state), { artifactState: state });

const messages = {
  unavailable: "The saved copy is unavailable. Check the approved inputs and reopen the file from its workspace.",
  changed: "The requested revision no longer matches the saved evidence. Reopen the file from its workspace to review the current revision.",
  protected: "This file contains protected content and cannot be displayed.",
  binary: "This file is not supported UTF-8 text.",
  empty: "This file is empty.",
  oversized: "This file exceeds the 1 MiB viewer limit.",
};

const snapshotRecovery = "Restore the coordinator’s saved copy or use the task’s approved snapshot recovery workflow.";
const legacyRecovery = "The queued PRD or sources changed or are missing. Review the saved chain evidence before restoring or reapproving the inputs.";

const descriptor = (path, origin, { digest = null, baseDigest, role = "Source", read } = {}) =>
  ({ path, origin, digest, baseDigest, role, read });

function collection(kind, reference, files, { revision, origin, recovery = "", detail = null, legacy = false, initial, discover, sourceDigest } = {}) {
  return { kind, key: reference.split(".")[1], files, revision, origin, recovery, detail, legacy, initial, discover, sourceDigest };
}

function taskCollection(ctx, id, entry) {
  const ref = taskBriefRef(id, entry);
  if (!ref) return null;
  const sources = sourcePathsOf({ meta: { sources: entry.sources } });
  const origin = "Saved task snapshot", legacy = !artifactHash(entry.snapshot_digest);
  const readSource = path => disk(ctx.home, relative(ctx.home, sourceSnapshotPath(ctx.home, id, path)));
  const pinned = entry.plan && ctx.state.graphPlan?.(entry.plan.instanceId)?.approval.bindings.tasks
    .find(([node]) => node === entry.plan.node)?.[1]?.files;
  const sourcesFor = path => {
    if (artifactHash(entry.sources_digest)) {
      let remaining = PLAN_LIMITS.totalBytes;
      const captured = sources.map(file => {
        if (!availablePath(file)) throw stateError("protected");
        const bytes = readSource(file);
        remaining -= bytes.length;
        if (remaining < 0) throw stateError("oversized");
        return [file, bytes];
      });
      if (sourceManifestDigest(captured) !== entry.sources_digest) throw stateError("changed");
      return captured.find(([name]) => name === path)?.[1];
    }
    return readSource(path);
  };
  const brief = descriptor(entry.prd, origin, { digest: entry.snapshot_digest, role: "PRD",
    read: () => disk(ctx.home, relative(ctx.home, prdSnapshotPath(ctx.home, id))) });
  return collection("task", ref, [brief, ...sources.map(path => {
    const proof = pinned?.find(file => file.path === path);
    return descriptor(path, "Carried task snapshot", { digest: proof?.digest, baseDigest: proof?.baseDigest, read: () => sourcesFor(path) });
  })], { origin, legacy, revision: artifactHash(entry.snapshot_digest) ? entry.snapshot_digest :
      /^[a-f0-9]{12}$/.test(entry.prd_fingerprint ?? "") ? entry.prd_fingerprint : null,
    sourceDigest: artifactHash(entry.sources_digest) ? entry.sources_digest : null, recovery: snapshotRecovery,
    detail: legacy ? "No exact brief digest was recorded for this task. The viewer uses the saved coordinator copy when available." : null });
}

function intakeCollection(ctx, access, id) {
  if (access.protectedReads || !/^task-[a-f0-9]{24}$/.test(id ?? "")) return null;
  let task;
  try { task = taskStore(ctx.home).read(id); }
  catch { return null; }
  if (task.id !== id || !repoNames(ctx.config).includes(task.repo) || !Number.isSafeInteger(task.draft?.revision) ||
      !artifactHash(task.draft.hash)) return null;
  const dir = relative(ctx.home, join(taskRoot(ctx.home, id), "drafts", `revision-${task.draft.revision}`));
  const origin = "Saved intake draft", path = `docs/prds/${id}.md`;
  return collection("intake", intakeBriefRef(id, task.draft), [descriptor(path, origin, { role: "Draft PRD",
    digest: task.draft.hash, read: () => disk(ctx.home, join(dir, path)) })], {
    origin, revision: `Draft revision ${task.draft.revision}`, recovery: "Refresh the prepared task and review the saved draft again.",
  });
}

function legacyCheckout(chain, step, path) {
  if (!artifactHash(step.digest)) throw stateError("unavailable");
  // The root itself must also remain a directory. The shared reader checks
  // containment and file identity before and after reading each selected path.
  if (!lstatSync(step.checkout).isDirectory()) throw stateError("changed");
  const pinned = pinRepositoryRoot(step.checkout);
  let remaining = PLAN_LIMITS.totalBytes;
  const read = rel => {
    if (!availablePath(rel)) throw stateError("protected");
    const { bytes } = readPinnedRepositoryFile(pinned, rel, cap, remaining);
    remaining -= bytes.length;
    return bytes;
  };
  if (path) return read(path);
  const approved = new Map([[step.relPath, read(step.relPath)]]);
  const request = parsePrd(decoder.decode(approved.get(step.relPath)), step.relPath);
  const captured = captureStartInput({ ...request, repo: chain.repo, checkout: step.checkout, relPath: step.relPath },
    chain.base, (_checkout, rel) => {
      const bytes = read(rel);
      approved.set(rel, bytes);
      return decoder.decode(bytes);
    });
  if (captured.digest !== step.digest) throw stateError("changed");
  return approved;
}

function chainCollection(chain, step, access) {
  const ref = chainFilesRef(chain, step);
  if (!ref) return null;
  const origin = "Digest-pinned checkout input";
  const paths = [...new Set([step.relPath, ...Object.keys(step.inputFiles ?? {}), ...Object.keys(step.baseFiles ?? {})])];
  const reason = !chain.after || access.localAnchor(chain.after) ? factoryNote(chain.reason) : null;
  let approved;
  const checkoutFiles = () => approved ??= legacyCheckout(chain, step);
  const describe = path => descriptor(path, origin, {
    role: path === step.relPath ? "PRD" : "Carried source", digest: step.inputFiles?.[path], baseDigest: step.baseFiles?.[path],
    read: () => artifactHash(step.inputFiles?.[path]) ? legacyCheckout(chain, step, path) : checkoutFiles().get(path),
  });
  const discover = () => {
    if (step.inputFiles) return [];
    try { return [...checkoutFiles().keys()].filter(path => !paths.includes(path)).map(describe); }
    catch { return []; } // Keep the recorded brief and change evidence available.
  };
  return collection("chain", ref, paths.map(describe), { origin, revision: artifactHash(step.digest) ? step.digest : null, recovery: legacyRecovery, detail: reason, discover });
}

function planCollection(kind, reference, approval, read, { revision, manifest } = {}) {
  const graphTasks = new Map(approval.graph.nodes.filter(item => item.type === "task").map(item => [item.id, item]));
  const taskOrigins = new Map();
  for (const [id, task] of approval.bindings.tasks) {
    for (const file of task.files) {
      if (!taskOrigins.has(file.source)) taskOrigins.set(file.source, {
        ...file, role: file.path === graphTasks.get(id)?.prd ? "PRD" : "Carried source",
      });
    }
  }
  const origin = kind === "approval" ? "Saved plan review" : kind === "review" ? "Reviewed plan preview" : "Approved plan snapshot";
  const files = approval.sources.map(({ path, digest }) => {
    const input = taskOrigins.get(path);
    return descriptor(path, origin, { digest, baseDigest: input?.baseDigest, role: input?.role ?? "Manifest",
      read: () => read(path, digest) });
  });
  // Older approvals sorted the closure and did not record the root path. A
  // manifest with a repositories mapping is the root, even when an include sorts first.
  const initial = () => {
    if (approval.manifestPath ?? manifest) return approval.manifestPath ?? manifest;
    const manifests = files.filter(file => file.role === "Manifest");
    return manifests.find(file => {
      if (!availablePath(file.path)) return false;
      try {
        const bytes = file.read();
        return bytes && contentDigest(bytes) === file.digest && isPlanManifest(file.path, decoder.decode(bytes));
      } catch { return false; }
    })?.path ?? manifests[0]?.path;
  };
  return collection(kind, reference, files, { origin, revision, initial,
    recovery: kind === "review" ? "Open a fresh plan review to recover the reviewed files." :
      kind === "approval" ? "Create a new approval request if the reviewed files are no longer retained." :
      "The approved plan snapshot may have been pruned. Open the task snapshot when available, or review the plan inputs again." });
}

// Reviewed bytes come from the same capture that produced the review digest.
// The reference is a selector. Every read rechecks the operator and review scope.
const reviews = new WeakMap();
const reviewOwner = operator => artifactKey(operator?.tenant, operator?.principal, operator?.isolation.launchDigest);
const reviewTTL = 30 * 60_000;
export function rememberArtifactReview(ctx, operator, command, result, { approval, snapshots }) {
  const cache = reviews.get(ctx) ?? new Map();
  reviews.set(ctx, cache);
  const owner = reviewOwner(operator), key = artifactKey(owner, result.revision, approval.approvalDigest);
  const now = Date.now();
  for (const [ref, saved] of cache) if (saved.expires <= now) cache.delete(ref);
  cache.delete(key);
  while (cache.size >= 8) cache.delete(cache.keys().next().value);
  const scope = approval.bindings.scope, readGrant = scopeGrants(operator, scope, ["read"]);
  cache.set(key, { owner, readGrant, scope, command: { action: command.action, plan: result.instanceId },
    revision: result.revision, approval, snapshots, expires: now + reviewTTL });
  return artifactRef("review", key);
}

function reviewCollection(ctx, access, key) {
  const saved = reviews.get(ctx)?.get(key), { operator } = access;
  if (!saved || saved.expires <= Date.now() || saved.owner !== reviewOwner(operator) ||
      !canReadPlan(operator, saved.scope) || scopeGrants(operator, saved.scope, ["read"]) !== saved.readGrant) return null;
  if (saved.command.plan) {
    try { selectPlanControl(access.saved, operator, saved.command); }
    catch { return null; }
  }
  return planCollection("review", artifactRef("review", key), saved.approval, path => saved.snapshots.get(path), {
    revision: saved.revision, manifest: saved.snapshots.keys().next().value,
  });
}

function resolveCollection(ctx, access, kind, key, query) {
  const { id, task, plan, node, chain, milestone, approval } = query;
  if (kind === "task") {
    const entry = access.entries.get(id);
    return entry && taskCollection(ctx, id, entry);
  }
  if (kind === "intake") return intakeCollection(ctx, access, task);
  if (kind === "review") return reviewCollection(ctx, access, key);
  if (kind === "approval") {
    if (!access.operator || !isPlanReviewId(approval)) return null;
    const state = ctx.state.load(), saved = findSavedPlanReview(state, access.operator, approval);
    if (!saved || !reviewFilesAllowed(access.operator, saved)) return null;
    const revision = saved.approval.approvalDigest;
    return planCollection("approval", approvalFilesRef(approval, revision), saved.approval,
      (_path, hash) => Buffer.from(state.plans.reviewBlobs[hash], "base64"), { revision });
  }
  if (kind === "plan") {
    const saved = access.plans.find(record => record.id === plan);
    return saved && planCollection("plan", planFilesRef(saved), saved.approval, (_path, hash) => ctx.state.approvedPlanBlob?.(hash),
      { revision: `Plan revision ${saved.approval.revision} · ${saved.approval.approvalDigest}` });
  }
  const saved = access.chains.get(chain) ?? (plan && [...access.chains.values()].find(value => legacyPlan(value, { readOnly: true })?.id === plan));
  if (!saved || plan && legacyPlan(saved, { readOnly: true })?.id !== plan) return null;
  const step = saved.steps.find(value => milestone ? value.id === milestone : linearNodeId(value.id) === node);
  return step && chainCollection(saved, step, access);
}

const privateContent = (text, ctx) => {
  const secrets = [ctx.home, ...(ctx.taskSecrets ?? []), ctx.aportApiKey,
    (ctx.env ?? process.env)[ctx.config.intake_model?.credential_env], ctx.config.home].filter(Boolean);
  return redact(text, secrets) !== text || /\bhttps?:\/\/[^\s/@]+@|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{12,}\b|-----BEGIN [^-\n]*PRIVATE KEY-----|(?:^|[\s("'`=])(?:\/(?:Users|home|private|tmp|var\/folders)\/[^\s"'\`)]|[A-Z]:[\\/][^\s"'\`)])/im.test(text);
};

// Only the server’s selected record turns an opaque reference into a read.
export function readArtifact(ctx, access, query, origin) {
  const match = artifactReference.exec(query.artifact ?? "");
  if (!match || query.artifactAt && !artifactHash(query.artifactAt)) return null;
  const [, kind, key, wanted] = match;
  const result = resolveCollection(ctx, access, kind, key, query);
  if (!result) return null;
  const { revision, recovery, detail, legacy, sourceDigest } = result;
  const files = key === result.key && result.discover ? [...result.files, ...result.discover()] : result.files;
  const first = wanted === artifactKey(null), initial = first && key === result.key ? result.initial?.() : null;
  const selected = first ? files.find(file => file.path === initial) ?? files[0] :
    files.find(file => artifactKey(file.path) === wanted);
  if (!selected) return null;
  const metadata = file => ({
    path: availablePath(file.path) && redact(file.path) === file.path ? file.path : "Protected source path", role: file.role,
    ref: artifactRef(kind, result.key, file.path), origin: file.origin, digest: artifactHash(file.digest) ? file.digest : null,
    ...(file.baseDigest !== undefined ? { baseDigest: artifactHash(file.baseDigest) ? file.baseDigest : null } : {}),
  });
  const view = { file: metadata(selected), files: files.map(metadata), revision: revision ?? null, origin: result.origin,
    recovery, detail, legacy, sourceDigest };
  const fail = state => ({ ...view, state, message: messages[state] });
  if (key !== result.key) return fail("changed");
  if (!availablePath(selected.path) || redact(selected.path) !== selected.path) return fail("protected");
  try {
    const bytes = selected.read();
    if (!Buffer.isBuffer(bytes)) return fail("unavailable");
    if (bytes.length > cap) return fail("oversized");
    const digest = contentDigest(bytes);
    if (artifactHash(selected.digest) && digest !== selected.digest || query.artifactAt && digest !== query.artifactAt) return fail("changed");
    if (!bytes.length) return fail("empty");
    if (binaryExtensions.test(selected.path)) return fail("binary");
    let text;
    try { text = decoder.decode(bytes); }
    catch { return fail("binary"); }
    if (/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) return fail("binary");
    if (privateContent(text, ctx)) return fail("protected");
    const markdown = /^(?:\.md|\.markdown|\.mdown)$/i.test(extname(selected.path));
    const frontmatter = markdown && parseFrontmatter(text.replace(/^\uFEFF/, ""));
    return { ...view, state: "ready", digest, text,
      preview: markdown ? artifactMarkdown(Object.keys(frontmatter.meta).length ? frontmatter.body : text, origin) : null };
  } catch (error) {
    return fail(error.artifactState ?? (error.code === "FILE_TOO_LARGE" ? "oversized" : "unavailable"));
  }
}
