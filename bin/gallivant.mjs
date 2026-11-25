#!/usr/bin/env node
// CLI entry. Parses arguments, builds the context, calls one command. No logic lives here.
import { recoveryCommand, recoveryUsage } from "../lib/commands/recovery.mjs";
import { reviewCommand } from "../lib/commands/review.mjs";
import { acquireCliMutation } from "../lib/daemon.mjs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { makeContext } from "../lib/context.mjs";
import { start } from "../lib/commands/start.mjs";
import { register } from "../lib/commands/register.mjs";
import { up, upInBackground, readDaemon, down } from "../lib/commands/up.mjs";
import { status } from "../lib/commands/status.mjs";
import { why } from "../lib/commands/why.mjs";
import { doctor, renderDoctor } from "../lib/commands/doctor.mjs";
import { diagnoseNetwork, renderNetworkDiagnostics } from "../lib/network_diagnostics.mjs";
import { ready } from "../lib/commands/ready.mjs";
import { newPrd } from "../lib/commands/new.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { startServices } from "../lib/commands/start_services.mjs";
import { trackerPort, readTracker, stopTracker } from "../lib/tracker_process.mjs";
import { init, renderInit } from "../lib/commands/init.mjs";
import { VERSION, gallivantHome } from "../lib/fs.mjs";
import { hasConfig } from "../lib/config.mjs";
import { resolveHandle } from "../lib/state.mjs";
import { requestControl } from "../lib/control.mjs";
import { queueChain, retryChain, cancelChain, renderChains } from "../lib/chains.mjs";
import { taskCommand, renderTask } from "../lib/commands/task.mjs";
import { TASK_VERSION } from "../lib/tasks.mjs";
import { learnCommand } from "../lib/commands/learn.mjs";
import { safeDisplay } from "../lib/learning_data.mjs";
import { ciTimingView } from "../lib/ci_timing.mjs";
import { repositoryIdentity } from "../lib/repository.mjs";

const HELP = `gallivant: give an agent a task, let the review loop run, go outside.

  gallivant init [--harness codex|claude] [--worktrees <directory>] [--host-config <json>] [--base <branch>]
                                         set up the repository you are in: private config, this repo in repos,
                                         then doctor's report. Safe to repeat; never signs in or overwrites settings
  gallivant --version                    print the installed version
  gallivant ${recoveryUsage}
  gallivant doctor [--send] [--probe]   install checklist and health probe
  gallivant doctor --network <https-origin> [--json]   bounded DNS/HTTPS diagnosis
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
                [--implementation-target <file>] [--verify <command>] [--no-daemon]
                                         prepare an isolated brief for review; approve later with task start --run
                                         --delivery selects the typed delivery profile (the only delivery authority);
                                         --route drafts through the connected harness or the operator's bounded model route
                                         Claude, Codex and OpenAI Agents support isolated preparation.
                                         Other local harnesses use written PRDs; Codex Cloud dispatch is unavailable
  gallivant task answer <task-id> --revision <n> --request-id <answer-id> --answer <question-id=text>
                                         resume saved questions; --answer, --context and --verify may repeat
  gallivant task inspect <task-id> [--json] | task list [--json]
  gallivant task resume|validate|start <task-id> --revision <n> [--run] [--no-daemon] [--json]
                                         shared versioned operations; start --run approves the reviewed revision
  gallivant ready <prd.md> [--check]     check the PRD against the contract; flip it to ready when it passes
  gallivant plan setup [--check] [--worker <os-user>] [--json]
                                         check or enroll the isolated local worker and operator
  gallivant plan validate <file> [--dir <directory>] [--checkout <relative-directory>] [--json]
                                         compile a local JSON or YAML dependency plan for inspection
  gallivant plan preview <file> [--dir <directory>] [--checkout <relative-directory>]
  gallivant plan request <file> --approve <revision> [--request-id <id>]
                                         save a pending review and return its approval link
  gallivant plan approval <request-id>   inspect the saved review or admission receipt
  gallivant plan approve <request-id> --approve <revision>
                                         resolve the exact request and return its receipt or browser approval link
  gallivant plan queue <file> --approve <digest> [--request-id <id>]
                                         queue the exact reviewed plan through the private local service
  gallivant plan session --repo <owner/repo> [--repo <owner/repo> ...]
                                         issue a short-lived tracker session for configured repositories
  gallivant plan [inspect] [<name>]       inspect admitted plans through the protected operator ingress
                                         JSON for a selected plan includes its saved factory projection
  gallivant plan hold|unhold|cancel <plan> [--group <id>] --request-id <id> [--approve <revision>]
  gallivant plan retry <plan> --node <id> --request-id <id> [--approve <revision>]
  gallivant plan attach|edit <plan> <file> [--dir <directory>] --request-id <id> [--approve <revision>]
  gallivant plan migration [--approve <digest>]
                                         review a legacy checkpoint; keep the existing dispatch owner
  gallivant start [prd.md] [--no-daemon] [--no-server] [--no-open] [--port 8791] [--base <branch>]
                                         start the daemon and dashboard, then open it; optionally start a ready PRD
                                         --base sets the branch the PR targets and remembers it for this repository
  gallivant ci-timing <owner/repo> [--json]
                                         show the saved CI timing and activation revision
  gallivant register <pr-url> [--harness <name>] [--session <id>] [--worktree <dir>]
                                         watch a hand-made PR; on an existing entry, reset it
  gallivant chain <name> <prd1.md> <prd2.md> ... [--base <branch>]
  gallivant chain <name> --after <pr-url|handle> <next.md> ...
                                         queue ready PRDs; each starts after the previous PR is merged
  gallivant chain <name> --after-chain <producer> <next.md> ... [--approve <digest>]
  gallivant chain <name> --after-node <producer:node> <next.md> ... [--approve <digest>]
                                         review future boundaries and admit work through protected authority
  gallivant chain [<name>] [--cancel | --retry [--resnapshot]]
                                         inspect chains, stop future work, or retry after fixing a blocker
  gallivant up [--once]                  the daemon: recover from GitHub, then tick every poll_seconds
  gallivant down                         stop the daemon and standalone dashboard; active runs keep going
  gallivant status [--all] [--json]      task phase, recovery evidence, daemon health
  gallivant serve [--port 8791] [--no-open] [--no-daemon] [--foreground]
                                         open Overview, Plans, Tasks and System; foreground keeps the tracker attached
  gallivant why <handle>                 why a PR stopped; handle is <repo>#<pr>, a PRD path, or the id
  gallivant resume <handle> [--note "..."] [--resnapshot] [--fresh-session]
                                         put a stopped entry back to work in the session that was doing it;
                                         --resnapshot makes an edited brief the one the gate judges
                                         --fresh-session replaces retired learned memory after settlement
  gallivant recheck <handle>           queue a PR recheck without resetting its budget
  gallivant review retry <handle> --reason <text>
                                         retry confirmed incomplete or coordinator-cancelled review; retain pieces and limits
  gallivant review qualify --repo <owner/repo> [--capability text|image] [--run [--wait] [--retry --reason <text>]]
                                         inspect qualification; --run launches a bounded probe; --wait records its exit before returning
  gallivant review status <handle>     show pinned policy, owned verdict and unresolved review evidence
  gallivant review policy <handle> --mode external-required|first-party-required|both-required --reason "..."
                                         explicitly replace policy and re-evaluate the current head
  gallivant review dispute <handle> --finding <id> --reason "..."
                                         record a dispute for a person; never accepts the author's own dispute
  gallivant cancel <handle>            stop further dispatch; request provider cancellation
  gallivant say <handle> --note "..." [--interrupt]
                                         send an update in the same session; --interrupt stops the active run first
  gallivant remove <handle>              forget an entry; the PR, the branch and the checkout are left alone

Config: $GALLIVANT_HOME/config.json (default ~/.gallivant). Run doctor for the file to write.`;

const OPTIONS = {
  network: { type: "string" },
  check: { type: "boolean" }, once: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" },
  send: { type: "boolean" }, probe: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  "no-server": { type: "boolean" }, "no-open": { type: "boolean" }, foreground: { type: "boolean" }, worktrees: { type: "string" },
  "no-daemon": { type: "boolean" }, note: { type: "string" }, resnapshot: { type: "boolean" }, "fresh-session": { type: "boolean" }, interrupt: { type: "boolean" },
  base: { type: "string" }, after: { type: "string" }, "after-chain": { type: "string" }, "after-node": { type: "string" }, approve: { type: "string" },
  harness: { type: "string" }, session: { type: "string" }, worktree: { type: "string" }, dir: { type: "string" }, port: { type: "string" },
  cancel: { type: "boolean" }, retry: { type: "boolean" }, wait: { type: "boolean" },
  run: { type: "boolean" }, stdin: { type: "boolean" }, repo: { type: "string" }, revision: { type: "string" },
  "request-id": { type: "string" }, context: { type: "string", multiple: true },
  "completion-target": { type: "string" }, delivery: { type: "string" }, route: { type: "string" },
  answer: { type: "string", multiple: true }, verify: { type: "string", multiple: true },
  since: { type: "string" }, until: { type: "string" }, "dry-run": { type: "boolean" },
  mode: { type: "string" }, status: { type: "string" }, from: { type: "string" }, reason: { type: "string" },
  "implementation-target": { type: "string", multiple: true },
  "recovery-profile": { type: "string" },
  "host-config": { type: "string" },
  "key-path": { type: "string" }, "ssh-keygen": { type: "string" }, "learning-budget": { type: "string" },
  finding: { type: "string" }, capability: { type: "string" },
};

async function planCommand(args, values) {
  const [action, target] = args;
  const compileOptions = { directory: resolve(values.dir ?? process.cwd()), checkouts: values.checkout };
  const fields = (...keys) => Object.keys(values).every(key => ["json", ...keys].includes(key));
  if (action === "setup") {
    if (args.length !== 1 || !fields("check", "worker")) throw new Error("usage: plan setup [--check] [--worker USER] [--json]");
    const { setupLocalPlans } = await import("../lib/local_plan_service.mjs");
    const { privatePlanConfig } = await import("../lib/local_plan_boundary.mjs");
    const home = gallivantHome();
    const rawConfig = privatePlanConfig(home);
    const ctx = makeContext({ home, readOnly: true, rawConfig });
    const report = await setupLocalPlans(ctx, { check: values.check, worker: values.worker }, { tracker: () => readTracker(home) });
    const next = report.prerequisite || report.next;
    const output = values.json ? JSON.stringify(report) : [
      `Host: ${report.host.join(", ")} · ${report.platform}/${report.architecture}`,
      `Worker: ${report.worker.route} · ${Object.values(report.worker.executables).filter(Boolean).join(", ") || "unconfigured"} · ${report.worker.account ?? "no OS account selected"}`,
      `Isolation: ${report.isolation.status} (${report.isolation.launcher}) · model access: ${report.worker.modelAccess}`,
      `Approval access: ${report.approvalAccess}`,
      `Graph capacity: ${report.capacity.graph_authors} total, ${report.capacity.graph_per_repository} per repository`,
      ...(next ? [next] : []),
    ].join("\n");
    process.stdout.write(`${output}\n`);
    return report.prerequisite && (values.check || report.approvalAccess !== "enrolled") ? 1 : 0;
  }
  if (action === "validate" && args.length === 2 && fields("dir", "checkout")) {
    const { compileDependencyPlan } = await import("../lib/dependency_plan.mjs");
    const preview = compileDependencyPlan(target, compileOptions);
    if (values.json) process.stdout.write(`${JSON.stringify(preview)}\n`);
    else {
      const { graph, graphDigest, approvalDigest } = preview;
      const tasks = graph.nodes.filter(node => node.type === "task").length;
      process.stdout.write(`${graph.name}: ${tasks} tasks, ${graph.nodes.length - tasks} unresolved anchors, ${graph.edges.length} dependencies\ngraphDigest ${graphDigest}\napprovalDigest ${approvalDigest}\n`);
    }
    return 0;
  }
  const { planControl, PLAN_CONTROL_ACTIONS, previewPlan, queuePlan, inspectPlan, migratePlans } = await import("../lib/dependency_plan_admission.mjs");
  const { callLocalPlans } = await import("../lib/local_plan_service.mjs");
  if (["request", "approval", "approve"].includes(action)) {
    const creating = action === "request";
    if (args.length !== 2 || !fields(...(creating ? ["dir", "checkout", "approve", "request-id"] : action === "approve" ? ["approve"] : [])) ||
        action !== "approval" && !/^[a-f0-9]{64}$/.test(values.approve ?? "")) {
      throw new Error("Use plan request FILE --approve REVISION, plan approval REQUEST_ID or plan approve REQUEST_ID --approve REVISION.");
    }
    const { newPlanReviewId } = await import("../lib/dependency_plan_registry.mjs");
    const home = gallivantHome();
    const result = await callLocalPlans(home, creating
      ? { op: "control", action: "queue", stage: "save", requestId: values["request-id"] ?? newPlanReviewId(),
        approve: values.approve, input: { file: target, options: compileOptions } }
      : { op: "approval", requestId: target });
    if (action === "approve" && result.revision !== values.approve) throw new Error("The supplied revision does not match the saved request. Review the approval link.");
    const { proposal: _proposal, ...reference } = result;
    const needsHumanApproval = action === "approve" && result.status !== "accepted";
    process.stdout.write(`${JSON.stringify(needsHumanApproval ? { ...reference, operatorAction: "open-approval-link" } : result)}\n`);
    return needsHumanApproval ? 1 : 0;
  }
  if (action === "session") {
    if (args.length !== 1 || !values.repo?.length || !fields("repo")) throw new Error("usage: plan session --repo OWNER/REPO");
    const session = await callLocalPlans(gallivantHome(), { op: "session", repositories: values.repo });
    process.stdout.write(`${JSON.stringify(session)}\n`);
    return 0;
  }
  if (action !== "queue" && PLAN_CONTROL_ACTIONS.includes(action)) {
    const edit = ["attach", "edit"].includes(action);
    if (args.length !== (edit ? 3 : 2) || !fields("approve", "request-id",
      ...(edit ? ["dir", "checkout"] : action === "retry" ? ["node"] : ["group"]))) {
      throw new Error("Supply the plan, action scope and request ID. See plan --help.");
    }
    const command = { action, plan: target, requestId: values["request-id"], stage: values.approve === undefined ? "review" : "confirm",
      ...(values.approve !== undefined ? { approve: values.approve } : {}),
      ...(values.group !== undefined ? { group: values.group } : {}),
      ...(values.node !== undefined ? { node: values.node } : {}),
      ...(edit ? { input: { file: args[2], options: compileOptions } } : {}) };
    const ctx = makeContext({ readOnly: true });
    const result = ctx.localPlans.enabled ? await callLocalPlans(ctx.home, { op: "control", ...command }) : await planControl(ctx, command);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (["validate", "preview", "queue"].includes(action) && (args.length !== 2 || !fields("dir", "checkout", ...(action === "queue" ? ["approve", "request-id"] : []))) ||
      action === "migration" && (args.length !== 1 || !fields("approve")) ||
      !["validate", "preview", "queue", "migration"].includes(action) && (args.length > (action === "inspect" ? 2 : 1) || !fields()) ||
      values["request-id"] !== undefined && values.approve === undefined) {
    throw new Error("usage: plan validate|preview|queue <file> | plan [inspect] [<name>] | plan migration [--approve <digest>]");
  }
  const ctx = makeContext({ readOnly: true }), input = { file: target, options: compileOptions };
  if (action === "queue" && !values.approve) throw new Error("Preview the plan and supply its exact approval digest with --approve.");
  if (ctx.localPlans.enabled) {
    const approve = values.approve;
    const selector = action === "inspect" ? target : action;
    const command = action === "preview" ? { op: "preview", ...input }
      : action === "queue" ? { op: "control", action, stage: "confirm", input, approve, requestId: values["request-id"] ?? approve }
      : action === "migration" ? { op: "migration", approve }
      : { op: "inspect", selector };
    let result;
    try { result = await callLocalPlans(ctx.home, command); }
    catch (error) {
      if (action !== "preview" || error.code !== "PLAN_QUALIFICATION") throw error;
      result = await previewPlan(ctx, input);
      result.observation.localSetup = error.message;
    }
    const report = action === "queue" ? { ...result, planLink: `/plans?plan=${encodeURIComponent(result.instanceId)}` } : result;
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }
  const result = action === "preview" ? await previewPlan(ctx, input)
    : action === "queue" ? await queuePlan(ctx, input, { approve: values.approve, requestId: values["request-id"] })
    : action === "migration" ? migratePlans(ctx, values.approve)
    : inspectPlan(ctx, action === "inspect" ? target : action);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function dispatch(argv) {
  const options = argv[0] === "learn" ? { ...OPTIONS, run: { type: "string" } }
    : argv[0] === "plan" ? { dir: OPTIONS.dir, json: OPTIONS.json, help: OPTIONS.help, approve: OPTIONS.approve, "request-id": OPTIONS["request-id"],
      check: OPTIONS.check, repo: { type: "string", multiple: true }, worker: { type: "string" }, group: { type: "string" }, node: { type: "string" }, checkout: { type: "string", multiple: true } }
    : OPTIONS;
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  const [cmd, arg] = positionals;
  if (values.version) { console.log(VERSION); return 0; }
  if (values.help || !cmd || cmd === "help") { console.log(HELP); return 0; }
  if (cmd === "plan") return planCommand(positionals.slice(1), values);
  if (values.after !== undefined && (cmd !== "chain" || !values.after.trim())) throw new Error("--after requires a registered PR URL or handle when queuing a new chain");
  const afterChain = values["after-chain"], afterNode = values["after-node"];
  if ([afterChain, afterNode].some(value => value !== undefined)) {
    const options = ["after-chain", "after-node", "approve", "request-id", "base", "json", "no-daemon"];
    if (cmd !== "chain" || positionals.length < 3 || (afterChain === undefined) === (afterNode === undefined) ||
        Object.keys(values).some(key => !options.includes(key)) || values["request-id"] !== undefined && values.approve === undefined) {
      throw new Error("Supply one future producer reference and ready PRD paths when queuing a new chain.");
    }
    const { futurePlanTarget, queuePlan } = await import("../lib/dependency_plan_admission.mjs");
    const target = futurePlanTarget(arg, afterChain, afterNode);
    const ctx = makeContext({ readOnly: true });
    const input = { linear: { name: arg, paths: positionals.slice(2).map(path => resolve(path)), base: values.base, target } };
    const approve = values.approve, requestId = values["request-id"] ?? approve;
    const { callLocalPlans } = await import("../lib/local_plan_service.mjs");
    const report = ctx.localPlans.enabled ? await callLocalPlans(ctx.home, approve === undefined ? { op: "preview", ...input }
      : { op: "control", action: "queue", stage: "confirm", input, approve, requestId }) : await queuePlan(ctx, input, { approve, requestId });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }
  if (values.approve !== undefined) throw new Error("--approve is available only for protected plan commands and future chain references");
  if (cmd === "init") {
    if (arg) throw new Error("init takes no positional argument; run it from inside the target checkout");
    const r = await init({ harness: values.harness, worktrees: values.worktrees, hostConfig: values["host-config"], base: values.base });
    const report = renderDoctor(r.doctor);
    console.log(renderInit(r, report));
    // Doctor's exit code, so a script or an agent reading only the status knows whether setup still has open items.
    return report.exitCode;
  }
  if (values.foreground && cmd !== "serve") throw new Error("--foreground is available only with serve");
  if (values.foreground && values["no-server"]) throw new Error("--foreground cannot be combined with --no-server");
  // Validate before a PRD can dispatch paid work.
  const serviceOptions = { port: ["start", "serve"].includes(cmd) ? trackerPort(values.port) : undefined,
    noDaemon: values["no-daemon"], noServer: values["no-server"], noOpen: values["no-open"], foreground: values.foreground };
  if (cmd === "recovery") {
    const report = await recoveryCommand(makeContext({ readOnly: true }), positionals.slice(1));
    console.log(JSON.stringify(report, null, 2));
    return report.readiness && !report.readiness.ready ? 1 : 0;
  }
  if (cmd === "learn") {
    const ctx = makeContext({ needConfig: arg !== "setup" && (arg !== "doctor" || !!values.repo), readOnly: !!values["dry-run"] || ["list", "show", "report", "explain", "doctor"].includes(arg) });
    const owner = !values["dry-run"] && !["list", "show", "report", "explain", "doctor", "setup"].includes(arg) ? acquireCliMutation(ctx.home) : null;
    let result;
    try { result = await learnCommand(ctx, { args: arg ? positionals.slice(1) : [], values }); }
    finally { owner?.release(); }
    process.stdout.write(safeDisplay(result) + "\n");
    return result?.isolation?.qualified === false ? 1 : 0;
  }

  if (values.network && cmd !== "doctor") throw new Error("--network is available only with doctor");
  if (cmd === "doctor" && values.network) {
    const result = await diagnoseNetwork(values.network);
    console.log(values.json ? JSON.stringify(result, null, 2) : renderNetworkDiagnostics(result));
    return result.ok ? 0 : 1;
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
  // Check maintenance/pin eligibility up front. The queue operation takes its
  // actual mutation lease after host reads, immediately before admission.
  if (cmd === "chain" && positionals.length > 2) acquireCliMutation(ctx.home).release();
  const mutating = ["start", "resume", "register", "remove", "recheck", "say", "cancel"].includes(cmd) || cmd === "review" && arg !== "status" || cmd === "chain" && (values.cancel || values.retry);
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
    case "review": {
      const result = await reviewCommand(ctx, { action: arg, handle: positionals[2], repo: values.repo, mode: values.mode, reason: values.reason, finding: values.finding, run: values.run, capability: values.capability, retry: values.retry, wait: values.wait });
      console.log(JSON.stringify(result, null, 2));
      return result.qualified === false ? 1 : 0;
    }
    case "chain": {
      const paths = positionals.slice(2);
      const operation = paths.length > 0 || values.retry;
      if (values.cancel && (values.retry || values.resnapshot || paths.length)) throw new Error("--cancel cannot be combined with a new plan or --retry");
      if (values.resnapshot && !values.retry) throw new Error("chain --resnapshot requires --retry");
      if (values.retry && paths.length) throw new Error("--retry uses the existing plan; do not pass PRD paths");
      if ((values.cancel || values.retry) && !arg) throw new Error("a chain name is required");
      if (values.base && !paths.length) throw new Error("--base is set when queuing a new chain");
      if (values.after && (!paths.length || values.retry || values.cancel)) throw new Error("--after is set only when queuing a new chain with ready PRD paths");
      if (paths.length) await queueChain(ctx, { name: arg, paths, base: values.base, after: values.after });
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
        const r = await start(ctx, { path: arg, base: values.base, recoveryProfile: values["recovery-profile"] });
        console.log(`${r.id}: started in ${r.worktree} on ${r.branch} -> ${r.base} (run ${r.run})`);
        const timing = ctx.state.get(r.id)?.ciTiming;
        if (timing) process.stdout.write(`CI ${timing.timing === "after-review" ? "after review" : "immediately"}${timing.revision ? ` · approved revision ${timing.revision}` : ""}\n`);
        if (r.baseSource === "flag") console.log(`Base branch ${r.base} remembered for this repository; later starts here need no --base.`);
        else if (r.baseSource === "config") console.log(`Base branch ${r.base} comes from repos in config.json.`);
      }
      const services = await startServices(ctx, serviceOptions);
      for (const message of services.messages) console.log(message);
      for (const error of services.errors) console.error(error);
      return services.errors.length ? 1 : 0;
    }
    case "ci-timing": {
      if (!arg || positionals.length !== 2) throw new Error("ci-timing needs one repository identity");
      const repo = repositoryIdentity(arg).key;
      const view = ciTimingView(ctx.config, ctx.state, repo);
      const text = values.json ? JSON.stringify(view, null, 2) : [
        `${repo} · CI ${view.timing === "after-review" ? "after review" : "immediately"}`,
        view.activation, view.revision && `Approval revision ${view.revision}`,
      ].filter(Boolean).join("\n");
      process.stdout.write(text + "\n");
      return 0;
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
