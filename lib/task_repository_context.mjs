// A bounded, read-only description of the selected repository for drafting:
// the HEAD revision and the tracked, non-ignored, non-private path listing,
// digested together so the snapshot is pinned to the prepared revision. File
// contents still reach the planner only through explicitly selected documents.
// Collection failures are reported as unavailable rather than guessed.
import { createHash } from "node:crypto";
import { redact } from "./execution_io.mjs";

export const REPOSITORY_CONTEXT_LIMITS = Object.freeze({ paths: 400, pathBytes: 16_384 });
// Secret, credential and agent-configuration locations never enter the listing
// even when a repository tracks them; the same families intake refuses as sources.
const PRIVATE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.aws|\.ssh|\.codex|\.claude|\.aport|\.gallivant|\.agents|\.config|\.npmrc|\.netrc|\.git|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|keystore|jks)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)(?:\/|$)/i;
const unavailable = reason => ({ status: "unavailable", reason, revision: null, digest: null, paths: [], counts: null, readOnly: true });
const sha = value => createHash("sha256").update(value).digest("hex");

export async function repositorySnapshot(git, checkout, { secrets = [] } = {}) {
  if (typeof git?.revision !== "function" || typeof git?.treePaths !== "function" || typeof git?.indexPaths !== "function" || typeof git?.ignoredTrackedPaths !== "function") {
    return unavailable("the Git adapter cannot enumerate the repository read-only; only explicitly selected documents are supplied as context");
  }
  try {
    const revision = String(await git.revision(checkout)).trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) return unavailable("the checkout has no resolvable HEAD commit; commit or fetch before preparing");
    // The listing is the recorded commit's tree, so revision and digest describe
    // one state. The index decides ignores; a tree path the index no longer
    // holds (a staged deletion) cannot be evaluated and is excluded.
    const tracked = await git.treePaths(checkout, revision);
    const index = new Set(await git.indexPaths(checkout));
    const ignored = new Set(await git.ignoredTrackedPaths(checkout));
    const counts = { tracked: tracked.length, ignored: 0, private: 0, unverified: 0, listed: 0, truncated: 0 };
    const approved = [];
    for (const path of [...tracked].sort()) {
      if (ignored.has(path)) { counts.ignored++; continue; }
      if (typeof path !== "string" || PRIVATE_PATH.test(path) || /[\x00-\x1f\x7f]/.test(path)) { counts.private++; continue; }
      if (!index.has(path)) { counts.unverified++; continue; }
      approved.push(path);
    }
    // The digest covers the complete approved listing at this revision, even
    // when the prompt receives a truncated prefix of it.
    const digest = sha(JSON.stringify({ revision, paths: approved }));
    const paths = [];
    let bytes = 0;
    for (const path of approved) {
      bytes += Buffer.byteLength(path) + 1;
      if (paths.length >= REPOSITORY_CONTEXT_LIMITS.paths || bytes > REPOSITORY_CONTEXT_LIMITS.pathBytes) break;
      paths.push(path);
    }
    counts.listed = paths.length;
    counts.truncated = approved.length - paths.length;
    return { status: "collected", revision, digest, paths, counts, readOnly: true, collectedAt: new Date().toISOString() };
  } catch (error) {
    return unavailable(`repository context could not be collected safely: ${redact(String(error?.message || error), secrets).slice(0, 500)}`);
  }
}
