// Builds the real dependencies once for the CLI. Tests build their own with fakes; nothing else imports this.
import { join } from "node:path";
import { load as loadConfig } from "./config.mjs";
import { makeState, idSlug } from "./state.mjs";
import { makeGh } from "./gh.mjs";
import { makeGit } from "./git.mjs";
import { makeNotifier } from "./notify.mjs";
import { makeLog } from "./log.mjs";
import { makeRunner } from "./run.mjs";
import { ensureDir, gallivantHome, readText, writeText } from "./fs.mjs";
import { aportDirFor, guardrailMode } from "./aport.mjs";

/** Where the daemon keeps its own copy of each PRD, taken at start, so a session cannot rewrite its brief. */
export const prdSnapshotPath = (home, id) => join(home, "prds", `${idSlug(id)}.md`);

export function makeContext({ home = gallivantHome(), needConfig = true } = {}) {
  ensureDir(home, 0o700);
  const log = makeLog(home);
  if (!needConfig) return { home, log };
  const config = loadConfig(home);
  const gh = makeGh({ tokenFile: config.github_token_file, log });
  return {
    home, log, config, gh,
    state: makeState(home),
    git: makeGit({ config }),
    notify: makeNotifier({ config, log }),
    runnerFor: id => makeRunner(join(home, "runs", idSlug(id))),
    // The APort API key the Claude install recorded, if any, so hosted gate calls count against the same account.
    aportApiKey: guardrailMode(aportDirFor(config.harness?.claude?.settings)).apiKey,
    readPrd: id => readText(prdSnapshotPath(home, id)),
    writePrd: (id, text) => writeText(prdSnapshotPath(home, id), text),
  };
}
