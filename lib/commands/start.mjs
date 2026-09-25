// `gallivant start <prd path>`: one brief becomes one running session in its own checkout.
//
// The brief arrives as a Request (lib/sources/), which already names the target repository. `start` no longer works
// the repo out from the file's directory: it reads `request.repo`, so the only thing that has to know where a brief
// lives is the source that read it.
import { join } from "node:path";
import { check, renderCheck, verifyCommands } from "../prd.mjs";
import { requestFor } from "../sources/index.mjs";
import { startPrompt } from "../prompt.mjs";
import { adapterFor, buildRun } from "../harness.mjs";
import { newEntry, entryId, STATES } from "../state.mjs";
import { branchFor, runEnv } from "../git.mjs";
import { rememberRepo } from "../config.mjs";
import { writeText } from "../fs.mjs";
import { nowIso } from "../time.mjs";
import { checkSignIn } from "../probe.mjs";
import { criteriaFromPrd, receiptInstructions } from "../deliverable.mjs";

export async function start(ctx, { path }) {
  const { config, state, gh, git, log, runnerFor, writePrd } = ctx;
  const request = await requestFor(path, { git, gh });
  // The gate. Every rule that applies to this source, every time, no override: a brief that fails cannot start.
  const verdict = check(request);
  if (!verdict.ok) throw new Error(`PRD fails the contract; nothing started.\n\n${renderCheck(request, verdict)}`);
  if (request.status !== "ready") throw new Error(`PRD status is "${request.status}". Run \`gallivant ready ${path}\` first.`);
  if (!config.harness[request.harness]) throw new Error(`harness "${request.harness}" is not configured in config.json`);

  // The source resolved these three by asking git which checkout the file is in and gh what that repository is
  // called. A PRD outside a checkout fails there, with git's own message, before anything is recorded.
  const { repo: nameWithOwner, defaultBranch, relPath: prdRel } = request;
  const id = entryId(nameWithOwner, request.id);
  if (state.get(id)) throw new Error(`${id} already exists; \`gallivant why ${id}\` explains it, \`gallivant remove ${id}\` forgets it`);

  // Nothing is recorded for a harness that is signed out: the fix is a login, after which start is simply rerun.
  const signedIn = await checkSignIn(request.harness, config);
  if (!signedIn.ok) throw new Error(`${request.harness} is not signed in (${signedIn.detail}); sign in and run start again`);

  // The daemon's own copy of the brief: fix rounds and the completion gate read this, never the checkout.
  writePrd(id, request.text);

  const branch = branchFor(request.id);
  const worktree = await git.create({ nameWithOwner, prdId: request.id, defaultBranch });
  // The PRD usually only exists in the operator's own checkout, so the fresh clone off the default branch does not
  // have it. Write it in at the same relative path before the session starts, so the branch carries the brief and
  // the PR can link it. The daemon's snapshot above stays the authoritative copy for the completion gate; this one
  // is writable by the session and is never read back for a decision.
  writeText(join(worktree, prdRel), request.text, 0o644, 0o755);
  const adapter = adapterFor(request.harness);
  const session = adapter.newSession();
  const receipt = config.deliverable ? receiptInstructions(criteriaFromPrd(request), id) : null;
  const prompt = startPrompt({ prd: request, repo: nameWithOwner, branch, defaultBranch, verify: verifyCommands(request), receipt });
  const spec = buildRun({ harness: request.harness, config, mode: "start", session, prompt, cwd: worktree });
  const job = runnerFor(id).start("start", spec.cmd, spec.args, { cwd: worktree, env: { ...runEnv(config), ...spec.env } });

  const entry = newEntry({ prd: prdRel, harness: request.harness, session, repo: nameWithOwner, branch, worktree, state: STATES.running, nowIso: nowIso() });
  state.put(id, { ...entry, last: { at: nowIso(), run: job.id, exit: null, event: "start" } });
  if (rememberRepo(nameWithOwner, config.home)) await gh.ensureLabels(nameWithOwner).catch(e => log.warn(`${nameWithOwner}: labels not created: ${e.message}`));
  log.info(`${id}: started ${request.harness} session in ${worktree}`);
  return { id, worktree, branch, session, run: job.id };
}
