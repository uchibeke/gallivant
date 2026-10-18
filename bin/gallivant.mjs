#!/usr/bin/env node
// CLI entry. Parses arguments, builds the context, calls one command. No logic lives here.
import { acquireCliMutation } from "../lib/daemon.mjs";
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
import { startServices } from "../lib/commands/start_services.mjs";
import { trackerPort, stopTracker } from "../lib/tracker_process.mjs";
import { init } from "../lib/commands/init.mjs";
import { VERSION } from "../lib/fs.mjs";
import { hasConfig } from "../lib/config.mjs";
import { resolveHandle } from "../lib/state.mjs";
import { requestControl } from "../lib/control.mjs";
import { queueChain, retryChain, cancelChain, renderChains } from "../lib/chains.mjs";
import { taskCommand, renderTask } from "../lib/commands/task.mjs";
import { TASK_VERSION } from "../lib/tasks.mjs";
import { learnCommand } from "../lib/commands/learn.mjs";
import { safeDisplay } from "../lib/learning_data.mjs";

const HELP = `gallivant: give an agent a task, let the review loop run, go outside.

  gallivant init [--harness codex|claude] [--worktrees <directory>]
                                         create a private config; never overwrite settings or sign in for you
  gallivant --version                    print the installed version
  gallivant doctor [--send] [--probe]   install checklist and health probe
  gallivant learn [--repo owner/repo] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--dry-run]
                                         bounded historical feedback collection; independent coding cursor
  gallivant learn doctor [--repo owner/repo]
  gallivant learn setup --key-path <absolute-path> [--ssh-keygen /usr/bin/ssh-keygen]
                                         explicit interactive encrypted-key enrollment; isolation required
  gallivant learn configure --repo owner/repo --mode off|collect|apply
  gallivant learn list|report --repo owner/repo [--status pending]
  gallivant learn show|approve|retire|reject <id> --repo owner/repo --revision <SHA256> [--reason text]
  gallivant learn revise <id> --repo owner/repo --from reviewed-rule.json
  gallivant learn explain --repo owner/repo --run RUN_ID
  gallivant learn recover|prune --repo owner/repo
  gallivant learn extract --repo owner/repo --learning-budget <USD>
                                         data-only qualified profile required; list/report never infer
  gallivant new <name> [--harness <name>] [--dir <repo>]
                                         write a starting PRD into docs/prds/ of the repo you are in
  gallivant task [prepare] "<request>" [--stdin] [--dir <checkout>] [--repo <owner/repo>]
                [--base <branch>] [--harness <name>] [--context <file>] [--request-id <id>] [--run] [--json]
                [--completion-target delivery_ready|integrated] [--delivery pull_request] [--route harness|model]
                [--verify <command>] [--no-daemon]
                                         prepare an isolated brief; --run authorizes its exact ready revision
                                         --delivery selects the typed delivery profile (the only delivery authority);
                                         --route drafts through the connected harness or the operator's bounded model route
                                         Claude, Codex and OpenAI Agents support isolated preparation.
                                         Other local harnesses use written PRDs; Codex Cloud dispatch is unavailable
  gallivant task answer <task-id> --revision <n> --request-id <answer-id> --answer <question-id=text>
                                         resume saved questions; --answer, --context and --verify may repeat
  gallivant task inspect <task-id> [--json] | task list [--json]
  gallivant task resume|validate|start <task-id> --revision <n> [--run] [--no-daemon] [--json]
                                         shared versioned operations; start needs prior or --run authorization
  gallivant ready <prd.md> [--check]     check the PRD against the contract; flip it to ready when it passes
  gallivant start [prd.md] [--no-daemon] [--no-server] [--no-open] [--port 8791] [--base <branch>]
                                         start the daemon and dashboard, then open it; optionally start a ready PRD
                                         --base sets the branch the PR targets and remembers it for this repository
  gallivant register <pr-url> [--harness <name>] [--session <id>] [--worktree <dir>]
                                         watch a hand-made PR; on an existing entry, reset it
  gallivant chain <name> <prd1.md> <prd2.md> ... [--base <branch>]
                                         queue ready PRDs; each starts after the previous PR is merged
  gallivant chain [<name>] [--cancel | --retry [--resnapshot]]
                                         inspect chains, stop future work, or retry after fixing a blocker
  gallivant up [--once]                  the daemon: recover from GitHub, then tick every poll_seconds
  gallivant down                         stop the daemon and standalone dashboard; active runs keep going
  gallivant status [--all] [--json]      needs-you, running, daemon health
  gallivant serve [--port 8791] [--no-open] [--no-daemon] [--foreground]
                                         same startup as start without a PRD; foreground keeps the tracker attached
  gallivant why <handle>                 why a PR stopped; handle is <repo>#<pr>, a PRD path, or the id
  gallivant resume <handle> [--note "..."] [--resnapshot] [--fresh-session]
                                         put a stopped entry back to work in the session that was doing it;
                                         --resnapshot makes an edited brief the one the gate judges
                                         --fresh-session replaces retired learned memory after settlement
  gallivant recheck <handle>           queue a PR recheck without resetting its budget
  gallivant cancel <handle>            stop further dispatch; request provider cancellation
  gallivant say <handle> --note "..." [--interrupt]
                                         send an update in the same session; --interrupt stops the active run first
  gallivant remove <handle>              forget an entry; the PR, the branch and the checkout are left alone

Config: $GALLIVANT_HOME/config.json (default ~/.gallivant). Run doctor for the file to write.`;

const OPTIONS = {
  check: { type: "boolean" }, once: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" },
  send: { type: "boolean" }, probe: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  "no-server": { type: "boolean" }, "no-open": { type: "boolean" }, foreground: { type: "boolean" }, worktrees: { type: "string" },
  "no-daemon": { type: "boolean" }, note: { type: "string" }, resnapshot: { type: "boolean" }, "fresh-session": { type: "boolean" }, interrupt: { type: "boolean" },
  base: { type: "string" }, harness: { type: "string" }, session: { type: "string" }, worktree: { type: "string" }, dir: { type: "string" }, port: { type: "string" },
  cancel: { type: "boolean" }, retry: { type: "boolean" },
  run: { type: "boolean" }, stdin: { type: "boolean" }, repo: { type: "string" }, revision: { type: "string" },
  "request-id": { type: "string" }, context: { type: "string", multiple: true },
  "completion-target": { type: "string" }, delivery: { type: "string" }, route: { type: "string" },
  answer: { type: "string", multiple: true }, verify: { type: "string", multiple: true },
  since: { type: "string" }, until: { type: "string" }, "dry-run": { type: "boolean" },
  mode: { type: "string" }, status: { type: "string" }, from: { type: "string" }, reason: { type: "string" },
  "key-path": { type: "string" }, "ssh-keygen": { type: "string" }, "learning-budget": { type: "string" },
};

async function dispatch(argv) {
  const options = argv[0] === "learn" ? { ...OPTIONS, run: { type: "string" } } : OPTIONS;
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  const [cmd, arg] = positionals;
  if (values.version) { console.log(VERSION); return 0; }
  if (values.help || !cmd || cmd === "help") { console.log(HELP); return 0; }
  if (cmd === "init") {
    const r = await init({ harness: values.harness, worktrees: values.worktrees });
    console.log(`Created ${r.file}\nHarness: ${r.harness}\nWorktrees: ${r.config.worktrees}\n\nNext: gallivant doctor\nComplete the harness guardrail and repository setup before starting work:\n  https://github.com/uchibeke/gallivant/blob/main/docs/install.md\nPackaged templates:\n  ${r.templates.passport}\n  ${r.templates.sandbox}`);
    return 0;
  }
  if (values.foreground && cmd !== "serve") throw new Error("--foreground is available only with serve");
  if (values.foreground && values["no-server"]) throw new Error("--foreground cannot be combined with --no-server");
  // Validate before a PRD can dispatch paid work.
  const serviceOptions = { port: ["start", "serve"].includes(cmd) ? trackerPort(values.port) : undefined,
    noDaemon: values["no-daemon"], noServer: values["no-server"], noOpen: values["no-open"], foreground: values.foreground };
  if (cmd === "learn") {
    const ctx = makeContext({ needConfig: arg !== "setup" && (arg !== "doctor" || !!values.repo), readOnly: !!values["dry-run"] || ["list", "show", "report", "explain", "doctor"].includes(arg) });
    const owner = !values["dry-run"] && !["list", "show", "report", "explain", "doctor", "setup"].includes(arg) ? acquireCliMutation(ctx.home) : null;
    let result;
    try { result = await learnCommand(ctx, { args: arg ? positionals.slice(1) : [], values }); }
    finally { owner?.release(); }
    process.stdout.write(safeDisplay(result) + "\n");
    return result?.isolation?.qualified === false ? 1 : 0;
  }

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

  if (cmd === "task") {
    try {
      const ctx = makeContext();
      const r = await taskCommand(ctx, { args: positionals.slice(1), values });
      console.log(values.json ? JSON.stringify(r, null, 2) : renderTask(r));
      return r.status === "blocked" || r.daemonError ? 1 : 0;
    } catch (e) {
      if (!values.json) throw e;
      console.log(JSON.stringify({ version: TASK_VERSION, error: { code: e.code || "TASK_FAILED", message: e.message } }));
      return 1;
    }
  }
  const ctx = makeContext();
  const mutating = ["start", "resume", "register", "remove", "recheck", "say", "cancel"].includes(cmd) || cmd === "chain" && (positionals.length > 2 || values.cancel || values.retry);
  const owner = mutating ? acquireCliMutation(ctx.home) : null;
  try {
  if (cmd === "recheck" || cmd === "say" || cmd === "cancel") {
    if (!arg) throw new Error(`${cmd} needs a handle`);
    if (cmd === "say" && !values.note?.trim()) throw new Error("say needs --note with a message");
    const r = requestControl(ctx, { handle: arg, action: cmd === "say" ? "message" : cmd, note: values.note, interrupt: values.interrupt });
    console.log(`${r.entry}: ${r.action} queued; ${cmd === "cancel" ? "dispatch is fenced; the daemon will request and confirm cancellation" : r.interrupt ? "the daemon will stop the active run and resume its session with your message" : "it will wait for any active run to finish"}.`);
    if (!values["no-daemon"]) {
      try { await upInBackground(ctx); }
      catch (e) { console.error(`Request saved, but the daemon could not start: ${e.message}\nAfter fixing the daemon, the saved request will be picked up; do not resend it.`); return 1; }
    }
    return 0;
  }
  switch (cmd) {
    case "chain": {
      const paths = positionals.slice(2);
      const operation = paths.length > 0 || values.retry;
      if (values.cancel && (values.retry || values.resnapshot || paths.length)) throw new Error("--cancel cannot be combined with a new plan or --retry");
      if (values.resnapshot && !values.retry) throw new Error("chain --resnapshot requires --retry");
      if (values.retry && paths.length) throw new Error("--retry uses the existing plan; do not pass PRD paths");
      if ((values.cancel || values.retry) && !arg) throw new Error("a chain name is required");
      if (values.base && !paths.length) throw new Error("--base is set when queuing a new chain");
      if (paths.length) await queueChain(ctx, { name: arg, paths, base: values.base });
      else if (values.cancel) cancelChain(ctx, arg);
      else if (values.retry) await retryChain(ctx, { name: arg, resnapshot: values.resnapshot });
      console.log(renderChains(ctx, arg));
      if (operation && !values["no-daemon"]) {
        try { await upInBackground(ctx); }
        catch (e) { console.error(`Chain saved, but the daemon could not start: ${e.message}\nRun gallivant up after fixing it; do not queue the chain again.`); return 1; }
      } else if (operation) console.log("Saved. Run gallivant up to dispatch the chain.");
      return 0;
    }
    case "start":
    case "serve": {
      if (cmd === "serve" && arg) throw new Error("serve does not take a PRD; use gallivant start <prd.md>");
      if (cmd === "start" && arg) {
        const r = await start(ctx, { path: arg, base: values.base });
        console.log(`${r.id}: started in ${r.worktree} on ${r.branch} -> ${r.base} (run ${r.run})`);
        if (r.baseSource === "flag") console.log(`Base branch ${r.base} remembered for this repository; later starts here need no --base.`);
        else if (r.baseSource === "config") console.log(`Base branch ${r.base} comes from repos in config.json.`);
      }
      const services = await startServices(ctx, serviceOptions);
      for (const message of services.messages) console.log(message);
      for (const error of services.errors) console.error(error);
      return services.errors.length ? 1 : 0;
    }
    case "register": { if (!arg) throw new Error("register needs a PR URL"); const r = await register(ctx, { url: arg, harness: values.harness, session: values.session, worktree: values.worktree }); console.log(`${r.id}: watching PR #${r.pr} with ${r.harness}`); return 0; }
    case "up": await up(ctx, { once: values.once }); return 0;
    case "down": {
      const tracker = stopTracker(ctx);
      const r = down(ctx);
      if (tracker.stopped) console.log(`Tracker ${tracker.pid} stopping.`);
      if (!r.stopped && !tracker.stopped) { console.error(`${r.why}; ${tracker.why}`); return 1; }
      if (r.stopped) console.log(`Daemon ${r.pid} stopping. Active runs keep going; gallivant start resumes monitoring.`);
      if (tracker.unverified) { console.error(tracker.why); return 1; }
      return 0;
    }
    case "status": { const r = status(ctx, { all: values.all, json: values.json }); console.log(r.text); return r.exitCode; }
    case "new": {
      if (!arg) throw new Error("new needs a name, for example: gallivant new widget-export");
      const r = await newPrd(ctx, { name: arg, harness: values.harness, dir: values.dir });
      console.log(`${r.rel}\n\nEdit it, then:\n  gallivant ready ${r.rel} --check\n  gallivant ready ${r.rel}\n  gallivant start ${r.rel}`);
      return 0;
    }
    case "why": { if (!arg) throw new Error("why needs a handle"); console.log(why(ctx, { handle: arg })); return 0; }
    case "resume": {
      if (!arg) throw new Error("resume needs a handle: the id, a PRD path, or <repo>#<pr>");
      const r = await resume(ctx, { handle: arg, note: values.note, resnapshot: values.resnapshot, freshSession: values["fresh-session"] });
      console.log(`${r.handle}: resumed in ${r.worktree} (run ${r.run})${r.attach ? `\nby hand: ${r.attach}` : "\nProvider progress is recorded by the coordinator."}`);
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
  } finally { owner?.release(); }
}

async function main(argv) {
  try { return await dispatch(argv); }
  catch (e) {
    if (argv[0] === "learn") e.message = safeDisplay({ error: { code: e.code || "LEARNING_FAILED", message: e.message } });
    throw e;
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`error: ${e.message}`); process.exitCode = 1; });
