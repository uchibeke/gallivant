#!/usr/bin/env node
// CLI entry. Parses arguments, builds the context, calls one command. No logic lives here.
import { parseArgs } from "node:util";
import { makeContext } from "../lib/context.mjs";
import { start } from "../lib/commands/start.mjs";
import { register } from "../lib/commands/register.mjs";
import { up, upInBackground, readDaemon, down } from "../lib/commands/up.mjs";
import { status } from "../lib/commands/status.mjs";
import { why } from "../lib/commands/why.mjs";
import { doctor, renderDoctor } from "../lib/commands/doctor.mjs";
import { ready } from "../lib/commands/ready.mjs";
import { newPrd } from "../lib/commands/new.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { serve, DEFAULT_PORT } from "../lib/commands/serve.mjs";
import { hasConfig } from "../lib/config.mjs";
import { resolveHandle } from "../lib/state.mjs";
import { requestControl } from "../lib/control.mjs";

const HELP = `gallivant: write a PRD, mark it ready, go outside.

  gallivant doctor [--send] [--probe]   install checklist and health probe
  gallivant new <name> [--harness <name>] [--dir <repo>]
                                         write a starting PRD into docs/prds/ of the repo you are in
  gallivant ready <prd.md> [--check]     check the PRD against the contract; flip it to ready when it passes
  gallivant start <prd.md> [--no-daemon] [--base <branch>]
                                         start a session for a ready PRD, and bring the daemon up to watch it.
                                         --base sets the branch the PR targets and remembers it for this repository
  gallivant register <pr-url> [--harness <name>] [--session <id>] [--worktree <dir>]
                                         watch a hand-made PR; on an existing entry, reset it
  gallivant up [--once]                  the daemon: recover from GitHub, then tick every poll_seconds
  gallivant down                         stop the daemon. A run already spawned keeps going
  gallivant status [--all] [--json]      needs-you, running, daemon health
  gallivant serve [--port 8791]          local tracker: live logs, PR recheck and session updates
  gallivant why <handle>                 why a PR stopped; handle is <repo>#<pr>, a PRD path, or the id
  gallivant resume <handle> [--note "..."] [--resnapshot]
                                         put a stopped entry back to work in the session that was doing it;
                                         --resnapshot makes an edited brief the one the gate judges
  gallivant recheck <handle>           queue a PR recheck without resetting its budget
  gallivant say <handle> --note "..."  queue an update for the same session after its current run
  gallivant remove <handle>              forget an entry; the PR, the branch and the checkout are left alone

Config: $GALLIVANT_HOME/config.json (default ~/.gallivant). Run doctor for the file to write.`;

const OPTIONS = {
  check: { type: "boolean" }, once: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" },
  send: { type: "boolean" }, probe: { type: "boolean" }, help: { type: "boolean", short: "h" },
  "no-daemon": { type: "boolean" }, note: { type: "string" }, resnapshot: { type: "boolean" },
  base: { type: "string" }, harness: { type: "string" }, session: { type: "string" }, worktree: { type: "string" }, dir: { type: "string" }, port: { type: "string" },
};

const portOf = v => {
  if (v === undefined) return DEFAULT_PORT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port takes a port number, not "${v}"`);
  return n;
};

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, arg] = positionals;
  if (values.help || !cmd || cmd === "help") { console.log(HELP); return 0; }

  if (cmd === "doctor") { const r = renderDoctor(await doctor({ send: values.send, probe: values.probe })); console.log(r.text); return r.exitCode; }
  if (cmd === "ready") {
    if (!arg) throw new Error("ready needs a PRD path");
    // A check only reads the brief and its sources. Recording readiness uses optional config; invalid config
    // remains an error for that operation rather than silently selecting a local decision.
    let readyCtx = {};
    if (!values.check && hasConfig()) { const c = makeContext(); readyCtx = { config: c.config, apiKey: c.aportApiKey, log: c.log }; }
    const r = await ready({ path: arg, checkOnly: values.check, ...readyCtx, onProgress: message => console.error(message) });
    console.log(r.report);
    return r.ok ? 0 : 1;
  }

  const ctx = makeContext();
  if (cmd === "recheck" || cmd === "say") {
    if (!arg) throw new Error(`${cmd} needs a handle`);
    if (cmd === "say" && !values.note?.trim()) throw new Error("say needs --note with a message");
    const r = requestControl(ctx, { handle: arg, action: cmd === "say" ? "resume" : "recheck", note: values.note });
    console.log(`${r.entry}: ${r.action} queued; it will wait for any active run to finish.`);
    if (!values["no-daemon"]) {
      try { await upInBackground(ctx); }
      catch (e) { console.log(`Request saved, but the daemon could not start: ${e.message}\n  gallivant up`); }
    }
    return 0;
  }
  switch (cmd) {
    case "start": {
      if (!arg) throw new Error("start needs a PRD path");
      const r = await start(ctx, { path: arg, base: values.base });
      console.log(`${r.id}: started in ${r.worktree} on ${r.branch} -> ${r.base} (run ${r.run})`);
      // Where the base came from, said once, because a base that is not the repository's default is the thing an
      // operator most wants confirmed before a session opens a pull request with it.
      if (r.baseSource === "flag") console.log(`Base branch ${r.base} remembered for this repository; later starts here need no --base.`);
      else if (r.baseSource === "config") console.log(`Base branch ${r.base} comes from repos in config.json.`);
      // `start` spawns the session; the daemon is what notices the PR, dispatches fixes and reaches ready. Without it
      // the session opens a pull request nobody looks at again, which is a silent stall rather than an error, so the
      // daemon comes up here rather than being a second command in a second terminal that an operator can forget.
      // `--no-daemon` is for the case where one is about to be run in the foreground.
      if (values["no-daemon"]) console.log("\nNo daemon started. Nothing watches the pull request until you run: gallivant up");
      else {
        try {
          const d = await upInBackground(ctx);
          console.log(d ? `\nDaemon running in the background (pid ${d.pid}). Watch it with: gallivant status` : "\nDaemon already running.");
        } catch (e) { console.log(`\nThe session started, but the daemon did not: ${e.message}\nRun it yourself so the pull request is watched:\n  gallivant up`); }
      }
      return 0;
    }
    case "register": { if (!arg) throw new Error("register needs a PR URL"); const r = await register(ctx, { url: arg, harness: values.harness, session: values.session, worktree: values.worktree }); console.log(`${r.id}: watching PR #${r.pr} with ${r.harness}`); return 0; }
    case "up": await up(ctx, { once: values.once }); return 0;
    case "down": {
      const r = down(ctx);
      if (!r.stopped) { console.error(`error: ${r.why}`); return 1; }
      console.log(`daemon ${r.pid} stopping (up since ${r.startedAt}). A run already spawned keeps going; the next \`gallivant up\` settles it.`);
      return 0;
    }
    case "status": { const r = status(ctx, { all: values.all, json: values.json }); console.log(r.text); return r.exitCode; }
    // Never resolves: the server holds the process open until it is interrupted.
    case "serve": { const port = portOf(values.port); await serve(ctx, { port }); console.log(`gallivant serve: http://127.0.0.1:${port}  this machine only. Ctrl-C to stop.`); return new Promise(() => {}); }
    case "new": {
      if (!arg) throw new Error("new needs a name, for example: gallivant new widget-export");
      const r = await newPrd(ctx, { name: arg, harness: values.harness, dir: values.dir });
      console.log(`${r.rel}\n\nEdit it, then:\n  gallivant ready ${r.rel} --check\n  gallivant ready ${r.rel}\n  gallivant start ${r.rel}`);
      return 0;
    }
    case "why": { if (!arg) throw new Error("why needs a handle"); console.log(why(ctx, { handle: arg })); return 0; }
    case "resume": {
      if (!arg) throw new Error("resume needs a handle: the id, a PRD path, or <repo>#<pr>");
      const r = await resume(ctx, { handle: arg, note: values.note, resnapshot: values.resnapshot });
      console.log(`${r.handle}: resumed in ${r.worktree} (run ${r.run})\nby hand: ${r.attach}`);
      // Printed because replacing the brief the gate judges is not something to do quietly, and the operator asked for it
      // one command ago: what they see back is what they actually changed.
      if (r.resnapshotted?.length) console.log(`\nThe brief was resnapshotted and the session was told what moved:\n${r.resnapshotted.map(l => `  - ${l}`).join("\n")}`);
      if (!readDaemon(ctx.home)?.alive) {
        try { const d = await upInBackground(ctx); console.log(d ? `\nDaemon running in the background (pid ${d.pid}).` : ""); }
        catch (e) { console.log(`\nThe run started, but the daemon did not: ${e.message}\n  gallivant up`); }
      }
      return 0;
    }
    case "remove": { if (!arg) throw new Error("remove needs a handle"); const id = resolveHandle(ctx.state.entries(), arg); ctx.state.remove(id); console.log(`${id}: removed from the registry`); return 0; }
    default: throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`error: ${e.message}`); process.exitCode = 1; });
