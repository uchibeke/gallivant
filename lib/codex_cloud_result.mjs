// Cloud diff -> bounded text manifest. Never apply a provider patch in the
// operator/task checkout; the shared result writer remains its only mutator.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { execFileAsync } from "./gh.mjs";
import { runEnv } from "./git.mjs";
import { contentHash, portablePath } from "./openai_agents_sources.mjs";
import { assertRepositoryTargets, readRepositoryText } from "./repository_files.mjs";
import { collectionValidationError } from "./execution_io.mjs";
export const CLOUD_RESULT_PATH = ".codex-cloud-result.json";
export async function cloudDiffResult(diff, op, { signal, exec = execFileAsync } = {}) {
  const fail = message => { throw collectionValidationError(message); };
  let root;
  try {
    if (typeof diff !== "string" || !diff.startsWith("diff --git ") || Buffer.byteLength(diff) > 1_048_576 || diff.includes("\0")) fail("missing, binary or oversized Cloud diff");
    const paths = [], headers = [];
    for (const block of diff.split(/^diff --git /m).slice(1)) {
      const header = block.slice(0, block.indexOf("\n"));
      const match = header.match(/^a\/(.+) b\/\1$/);
      if (!match) fail("Cloud patch has a renamed, quoted or unsupported path; retain the diff for explicit recovery");
      const path = portablePath(match[1]); paths.push(path);
      const metadata = block.split(/^@@/m)[0];
      if (/^(?:old mode|new mode|rename |copy |GIT binary|Binary files)/m.test(metadata) || /^new file mode (?!100644$)/m.test(metadata) || /^index [^\n]+ (?!100644|100755)\d{6}$/m.test(metadata) || /^deleted file mode (?!100644|100755)\d{6}$/m.test(metadata)) fail("unsupported Cloud file type/mode change");
      const old = metadata.match(/^--- (.+)$/m)?.[1], next = metadata.match(/^\+\+\+ (.+)$/m)?.[1];
      if (!old || !next || !["/dev/null", `a/${path}`].includes(old) || !["/dev/null", `b/${path}`].includes(next) || old === next) fail("Cloud diff header paths disagree");
      headers.push({ path, creation: old === "/dev/null", mode: metadata.match(/^index [^\n]+ (\d{6})$/m)?.[1] || metadata.match(/^deleted file mode (\d{6})$/m)?.[1] });
    }
    if (!paths.length || paths.length > 101 || new Set(paths).size !== paths.length || !paths.includes(CLOUD_RESULT_PATH)) fail("duplicate, excessive or missing Cloud diff/envelope paths");
    const raw = Buffer.from(op.sources.data, "base64");
    if (contentHash(raw) !== op.sources.hash) fail("saved Cloud snapshot hash differs");
    const source = JSON.parse(gunzipSync(raw, { maxOutputLength: 12 * 1024 * 1024 }).toString("utf8"));
    if (source.inputHead !== op.inputHead || source.repo !== op.repo || source.branch !== op.branch) fail("Cloud snapshot base/ownership differs");
    const before = new Map(source.files.map(file => [portablePath(file.path), file]));
    for (const header of headers) {
      const file = before.get(header.path);
      if (header.creation === Boolean(file) || header.mode && header.mode !== `100${file?.mode.toString(8)}`) fail("Cloud diff base file presence/mode disagrees with the exact input snapshot");
    }
    if (before.has(CLOUD_RESULT_PATH)) fail("reserved Cloud result path already exists in source");
    assertRepositoryTargets(paths, [...before.keys()]);
    root = mkdtempSync(join(tmpdir(), "cloud-diff-"));
    const checkout = join(root, "checkout"); mkdirSync(checkout);
    for (const file of source.files) {
      const path = portablePath(file.path), bytes = Buffer.from(file.data, "base64");
      if (contentHash(bytes) !== file.hash || ![0o644, 0o755].includes(file.mode)) fail("saved Cloud source bytes/mode differ");
      const target = join(checkout, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); chmodSync(target, file.mode);
    }
    const patch = join(root, "result.diff"); writeFileSync(patch, diff, { mode: 0o600 });
    const options = { cwd: checkout, signal, env: { PATH: process.env.PATH, ...runEnv(), HOME: root }, timeout: 5000, maxBuffer: 65_536 };
    try { await exec("git", ["apply", "--check", "--", patch], options); await exec("git", ["apply", "--", patch], options); }
    catch (error) { if (signal?.aborted || typeof error.code !== "number" || error.killed) throw error; fail("Cloud diff does not apply to the exact saved input revision"); }
    const receipt = JSON.parse(readRepositoryText(checkout, CLOUD_RESULT_PATH));
    const sorted = hashes => hashes && typeof hashes === "object" && !Array.isArray(hashes) ? JSON.stringify(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))) : null;
    if (receipt.version !== 1 || receipt.inputHead !== op.inputHead || receipt.repo !== op.repo || receipt.branch !== op.branch || receipt.runId !== op.runId || sorted(receipt.sourceHashes) !== sorted(op.sources.hashes) || !receipt.pr || !Array.isArray(receipt.tests) || receipt.tests.length > 100) fail("Cloud result envelope does not own this run/base/source snapshot");
    const files = paths.filter(path => path !== CLOUD_RESULT_PATH).map(path => {
      let text = null;
      try { text = readRepositoryText(checkout, path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const bytes = text === null ? null : readFileSync(join(checkout, path));
      if (text !== null && (text.includes("\0") || !Buffer.from(text).equals(bytes))) fail("Cloud text result is binary or invalid UTF-8");
      return { path, beforeHash: before.get(path)?.hash ?? null, afterHash: contentHash(text), text };
    });
    const textOnly = !files.length && op.continuity === "successor-task";
    if (!files.length && !textOnly) fail("Cloud diff has no deliverable file changes outside an approved successor");
    return { repo: op.repo, branch: op.branch, files, pr: receipt.pr, tests: receipt.tests,
      // Reuse the shared writer's exact pushed-revision path. It rechecks remote
      // head/ancestry, clean checkout and Verify evidence before updating one PR.
      ...(textOnly ? { pushedHead: op.inputHead } : {}),
      artifact: { source: "codex cloud diff --attempt 1", hash: contentHash(diff), inputHead: op.inputHead } };
  } catch (error) {
    if (signal?.aborted || error.collectionValidation || error.killed || /^(?:ENOENT|EACCES|EPERM|EIO|ENOSPC|EROFS|EMFILE|ENFILE|ENOMEM|ETIMEDOUT|ABORT_ERR)$/.test(error.code || "")) throw error;
    throw collectionValidationError("invalid Cloud result paths, snapshot or delivery envelope");
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
}
