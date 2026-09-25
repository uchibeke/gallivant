#!/usr/bin/env node
// CLI entry. Parses arguments, builds the context, calls one command. No logic lives here.
import { parseArgs } from "node:util";
import { makeContext } from "../lib/context.mjs";
import { start } from "../lib/commands/start.mjs";
import { register } from "../lib/commands/register.mjs";
import { up } from "../lib/commands/up.mjs";
import { status } from "../lib/commands/status.mjs";
import { why } from "../lib/commands/why.mjs";
import { doctor, renderDoctor } from "../lib/commands/doctor.mjs";
import { ready } from "../lib/commands/ready.mjs";
import { hasConfig } from "../lib/config.mjs";
import { resolveHandle } from "../lib/state.mjs";

const HELP = `gallivant: write a PRD, mark it ready, go outside.

  gallivant doctor [--send] [--probe]   install checklist and health probe
  gallivant ready <prd.md> [--check]     check the PRD against the contract; flip it to ready when it passes
  gallivant start <prd.md>               start a session for a ready PRD in its own checkout
  gallivant register <pr-url> [--harness claude|codex] [--session <id>] [--worktree <dir>]
                                         watch a hand-made PR; on an existing entry, reset it
  gallivant up [--once]                  the daemon: recover from GitHub, then tick every poll_seconds
  gallivant status [--all] [--json]      needs-you, running, daemon health
  gallivant why <handle>                 why a PR stopped; handle is <repo>#<pr>, a PRD path, or the id
  gallivant remove <handle>              forget an entry; the PR, the branch and the checkout are left alone

Config: $GALLIVANT_HOME/config.json (default ~/.gallivant). Run doctor for the file to write.`;

const OPTIONS = {
  check: { type: "boolean" }, once: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" },
  send: { type: "boolean" }, probe: { type: "boolean" }, help: { type: "boolean", short: "h" },
  harness: { type: "string" }, session: { type: "string" }, worktree: { type: "string" },
};

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, arg] = positionals;
  if (values.help || !cmd || cmd === "help") { console.log(HELP); return 0; }

  if (cmd === "doctor") { const r = renderDoctor(await doctor({ send: values.send, probe: values.probe })); console.log(r.text); return r.exitCode; }
  if (cmd === "ready") {
    if (!arg) throw new Error("ready needs a PRD path");
    // Config is optional here: without one the contract still runs and the decision is local only. An invalid
    // config is an error, not a reason to decide locally.
    let readyCtx = {};
    if (hasConfig()) { const c = makeContext(); readyCtx = { config: c.config, apiKey: c.aportApiKey, log: c.log }; }
    const r = await ready({ path: arg, checkOnly: values.check, ...readyCtx });
    console.log(r.report);
    return r.ok ? 0 : 1;
  }

  const ctx = makeContext();
  switch (cmd) {
    case "start": { if (!arg) throw new Error("start needs a PRD path"); const r = await start(ctx, { path: arg }); console.log(`${r.id}: started in ${r.worktree} on ${r.branch} (run ${r.run})`); return 0; }
    case "register": { if (!arg) throw new Error("register needs a PR URL"); const r = await register(ctx, { url: arg, harness: values.harness, session: values.session, worktree: values.worktree }); console.log(`${r.id}: watching PR #${r.pr} with ${r.harness}`); return 0; }
    case "up": await up(ctx, { once: values.once }); return 0;
    case "status": { const r = status(ctx, { all: values.all, json: values.json }); console.log(r.text); return r.exitCode; }
    case "why": { if (!arg) throw new Error("why needs a handle"); console.log(why(ctx, { handle: arg })); return 0; }
    case "remove": { if (!arg) throw new Error("remove needs a handle"); const id = resolveHandle(ctx.state.entries(), arg); ctx.state.remove(id); console.log(`${id}: removed from the registry`); return 0; }
    default: throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`error: ${e.message}`); process.exitCode = 1; });
