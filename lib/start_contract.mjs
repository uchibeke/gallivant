// Shared approval boundary for immediate starts and queued starts. Hash exactly the bytes start will copy.
import { contentDigest } from "./hash.mjs";
export { contentDigest } from "./hash.mjs";
import { check, renderCheck, sourcePathsOf } from "./prd.mjs";
import { validateContextPaths, parseContextPathsMeta } from "./config.mjs";
import { readRepositoryText } from "./repository_files.mjs";

export function validateStartRequest(request, config, path, options) {
  const verdict = check(request, options);
  if (!verdict.ok) throw new Error(`PRD fails the contract; nothing started.\n\n${renderCheck(request, verdict)}`);
  if (request.status !== "ready") throw new Error(`PRD status is "${request.status}". Run \`gallivant ready ${path}\` first.`);
  if (!config.harness[request.harness]) throw new Error(`harness "${request.harness}" is not configured in config.json`);
  const problems = validateContextPaths(parseContextPathsMeta(request.meta?.context_paths), config.home, `${request.id} frontmatter context_paths`);
  if (problems.length) throw new Error(`PRD frontmatter problems; nothing started.\n  - ${problems.join("\n  - ")}`);
}

export const sourceManifestDigest = sources => contentDigest(JSON.stringify(Array.from(sources, ([path, bytes]) => [path, contentDigest(bytes)])));

export function captureStartInput(request, base) {
  const sources = sourcePathsOf(request).map(rel => {
    const text = readRepositoryText(request.checkout, rel);
    if (text.includes("\u0000")) throw new Error(`${rel} is not text`);
    return [rel, text];
  });
  const files = [[request.relPath, request.text], ...sources];
  const digest = contentDigest(JSON.stringify([request.repo.toLowerCase(), request.checkout, base, files]));
  return { digest, sources, files };
}

// A carried planning file may override the queued base, but must not revert a newer integrated version.
export async function checkBaseFiles(input, baseFiles, readFile) {
  for (const [path, text] of input.files) {
    const current = contentDigest(await readFile(path));
    if (baseFiles[path] === null && current !== null && input.sources.some(([source]) => source === path)) {
      throw Object.assign(new Error(`${path} is a carried private input newly tracked on the approved base; preserve both copies and reconcile the collision before dispatch.`), { code: "CHAIN_INPUT_CHANGED" });
    }
    if (current !== baseFiles[path] && current !== contentDigest(text)) {
      throw Object.assign(new Error(`${path} changed on the base after this chain was approved; refusing to overwrite merged work. Reconcile the local input, then retry with --resnapshot.`), { code: "CHAIN_INPUT_CHANGED" });
    }
  }
}
