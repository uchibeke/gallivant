// `gallivant start <prd path>`: one PRD becomes one running session in its own checkout.
import { dirname, resolve, relative } from "node:path";
import { parsePrd, check, renderCheck, verifyCommands } from "../prd.mjs";
import { startPrompt } from "../prompt.mjs";
import { adapterFor, buildRun } from "../harness.mjs";
import { newEntry, entryId, STATES } from "../state.mjs";
import { branchFor, runEnv } from "../git.mjs";
import { rememberRepo } from "../config.mjs";
import { readText } from "../fs.mjs";
import { nowIso } from "../time.mjs";
import { checkSignIn } from "../probe.mjs";
import { criteriaFromPrd, receiptInstructions } from "../deliverable.mjs";

export async function start(ctx, { path }) {
  const { config, state, gh, git, log, runnerFor, writePrd } = ctx;
  const abs = resolve(path);
  const text = readText(abs);
  if (text === null) throw new Error(`cannot read ${abs}`);
  const prd = parsePrd(text, abs);
  // The gate. Every rule, every time, no override: a PRD that fails cannot start.
  const verdict = check(prd);
  if (!verdict.ok) throw new Error(`PRD fails the contract; nothing started.\n\n${renderCheck(prd, verdict)}`);
  if (prd.status !== "ready") throw new Error(`PRD status is "${prd.status}". Run \`gallivant ready ${path}\` first.`);
  if (!config.harness[prd.harness]) throw new Error(`harness "${prd.harness}" is not configured in config.json`);

  const repoDir = await git.toplevel(dirname(abs));
  const { nameWithOwner, defaultBranch } = await gh.repoInfo(repoDir);
  const id = entryId(nameWithOwner, prd.id);
  if (state.get(id)) throw new Error(`${id} already exists; \`gallivant why ${id}\` explains it, \`gallivant remove ${id}\` forgets it`);
  const prdRel = relative(repoDir, abs);

  // Nothing is recorded for a harness that is signed out: the fix is a login, after which start is simply rerun.
  const signedIn = await checkSignIn(prd.harness, config);
  if (!signedIn.ok) throw new Error(`${prd.harness} is not signed in (${signedIn.detail}); sign in and run start again`);

  // The daemon's own copy of the brief: fix rounds and the completion gate read this, never the checkout.
  writePrd(id, text);

  const branch = branchFor(prd.id);
  const worktree = await git.create({ nameWithOwner, prdId: prd.id, defaultBranch });
  const adapter = adapterFor(prd.harness);
  const session = adapter.newSession();
  const receipt = config.deliverable ? receiptInstructions(criteriaFromPrd(prd), id) : null;
  const prompt = startPrompt({ prd, repo: nameWithOwner, branch, defaultBranch, verify: verifyCommands(prd), receipt });
  const spec = buildRun({ harness: prd.harness, config, mode: "start", session, prompt, cwd: worktree });
  const job = runnerFor(id).start("start", spec.cmd, spec.args, { cwd: worktree, env: { ...runEnv(config), ...spec.env } });

  const entry = newEntry({ prd: prdRel, harness: prd.harness, session, repo: nameWithOwner, branch, worktree, state: STATES.running, nowIso: nowIso() });
  state.put(id, { ...entry, last: { at: nowIso(), run: job.id, exit: null, event: "start" } });
  if (rememberRepo(nameWithOwner, config.home)) await gh.ensureLabels(nameWithOwner).catch(e => log.warn(`${nameWithOwner}: labels not created: ${e.message}`));
  log.info(`${id}: started ${prd.harness} session in ${worktree}`);
  return { id, worktree, branch, session, run: job.id };
}
