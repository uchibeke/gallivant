// The PRD source: a markdown file in the operator's own checkout.
//
// Behaviour is unchanged from before the Request shape existed: parse the frontmatter for `status` and `harness`,
// take the id from the filename, let the contract read the body's sections, and find the target repository by asking
// git which checkout the file is in. What is new is that the answer is a field on the Request instead of something
// `start` works out for itself, so the rest of the pipeline never has to know the brief was a file.
import { basename, dirname, relative, resolve } from "node:path";
import { parsePrd } from "../prd.mjs";
import { readText } from "../fs.mjs";
import { repositoryPath } from "../repository_files.mjs";

export const kind = "prd";

/**
 * A filesystem path. `matches` is what the registry uses to pick this source, and it declines anything with a URL
 * scheme so a future source that reads one is not shadowed by a stray relative path.
 */
export const matches = input => typeof input === "string" && input.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(input);

/**
 * The Request for one PRD file.
 *
 * `repo` is `owner/name` and comes from the file's own git checkout: a PRD lives inside the repository it describes,
 * which is how this has always worked. `checkout` and `relPath` come with it, because the brief has to be copied into
 * the session's fresh clone at the path it has in the operator's tree. A file outside a checkout fails here, with
 * git's own message, which is the right place for it: the caller never has to hold a half-resolved Request.
 *
 * `git` and `gh` are injected. Omit them and you get the parsed Request with `repo` unset, which is what a caller
 * that only wants to run the contract needs; `gallivant ready` takes that shape through `request` below.
 */
export async function load(input, { git = null, gh = null } = {}) {
  const path = resolve(input);
  const text = readText(path);
  if (text === null) throw new Error(`cannot read ${path}`);
  const req = request(text, path);
  if (!git || !gh) return req;
  const checkout = await git.toplevel(dirname(path));
  repositoryPath(checkout, relative(checkout, path));
  const { nameWithOwner, defaultBranch } = await gh.repoInfo(checkout);
  return { ...req, repo: nameWithOwner, defaultBranch, checkout, relPath: relative(checkout, path) };
}

/**
 * The Request for PRD text at a path, with no filesystem, git or GitHub access. `parsePrd` already builds it: a
 * parsed PRD file is a Request whose `source.kind` is "prd".
 */
export const request = (text, path) => parsePrd(text, path);

/** The filename, for messages that name the file rather than the id. */
export const fileOf = req => (req.path ? basename(req.path) : req.id);
