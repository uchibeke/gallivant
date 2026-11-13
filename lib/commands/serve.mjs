import { workspaceQuery } from "../tracker/query.mjs";
import { acquireCliMutation } from "../daemon.mjs";
// `gallivant serve`: the tracker. One local page showing every entry and every run, with the log tailing live.
//
// Reads remain GET-only. One protected POST queues a local operator request; only the daemon
// applies it through the existing resume and review loop. No shell commands come from the browser.
//
// It binds to 127.0.0.1 and takes no auth, which is the same trust boundary as the CLI: anything that can reach it
// can already read ~/.gallivant. That is exactly why it must never bind to 0.0.0.0.
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { requestControl, lastMessage, validControlRequestId } from "../control.mjs";
import { controlView } from "../tracker/control_view.mjs";
import { model } from "./status.mjs";
import { isOurProcess, alive } from "../run.mjs";
import { executionRunner, executionLive, unsubmittedInitialDispatch } from "../execution.mjs";
import { logWindow } from "../run_log.mjs";
import { executionCapabilities } from "../harness.mjs";
import { redact } from "../execution_io.mjs";
import { readJson } from "../fs.mjs";
import { join } from "node:path";
// `handleFor` from state.mjs is the canonical handle. This file used to spell the rule again with its own fallback,
// and two spellings of one rule is how the canonical one kept the `undefined#3` bug that never showed up here.
import { handleFor } from "../state.mjs";
import { streamRun, sliceRun, TAIL } from "../tracker/stream.mjs";
import { listRuns, listFlatRuns, runDir, sourceRunDir, validRunId } from "../tracker/runs.mjs";
import { ASSETS, themeOf } from "../tracker/assets.mjs";
import { overviewSnapshot } from "../tracker/overview.mjs";
import { dashboard, runPage, runsPage, page, esc, CSP, GROUPINGS } from "../tracker/pages.mjs";
import { workspaceProjection, workspaceSnapshot } from "../tracker/workspace.mjs";
import { reviewActivity } from "../tracker/review.mjs";
import { chainsPage, chainsSnapshot } from "../tracker/chains.mjs";
import { chainControl } from "../tracker/chain_controls.mjs";
import { intakeCapabilities, inspectIntake, mutateIntake, intakeError } from "../tracker/intake_service.mjs";
import { intakePage, intakeReview } from "../tracker/intake.mjs";
import { healthPage, healthSnapshot } from "../tracker/health_page.mjs";

export const DEFAULT_PORT = 8791;
const HOST = "127.0.0.1";
const TOKENS = new WeakMap();
const tokenFor = ctx => {
  if (!TOKENS.has(ctx)) TOKENS.set(ctx, randomBytes(32).toString("hex"));
  return TOKENS.get(ctx);
};
// Check the peer and Host independently: loopback binding alone does not stop DNS rebinding.
const localRequest = req => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress)) return false;
  try {
    const host = req.headers.host;
    const url = new URL(`http://${host}`);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && url.host === host && Number(url.port || 80) === req.socket.localPort;
  } catch { return false; }
};

/** Headers every response carries. The CSP is explained in tracker/pages.mjs. */
const SECURITY = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const send = (res, code, type, body, cache = "no-store") => { res.writeHead(code, { "content-type": type, "cache-control": cache, ...SECURITY }); res.end(body); };
const html = (res, code, body) => send(res, code, "text/html; charset=utf-8", body);
const json = (res, code, value) => send(res, code, "application/json; charset=utf-8", JSON.stringify(value, null, 2));
const notFound = (res, what, view) => html(res, 404, page({ title: "not found - gallivant", theme: view?.theme, base: view?.base || "",
  body: `<header class="top"><h1>404</h1></header><main class="main" id="main" tabindex="-1"><p>${esc(what)}</p><p><a href="${esc(view?.base || "")}/">back to the dashboard</a></p></main>` }));

const liveness = job => job?.execution?.provider && !job.bin ? executionLive(job) : !!job && job.exit === null && isOurProcess(job.pid, job.bin);

/**
 * Every run the tracker knows about: Gallivant's own, plus any flat run trees the caller pointed it at.
 *
 * `ctx.runSources` is a list of `{ label, dir }`. The point of it is that a run folder is a run folder: command
 * center writes the same job.json and job.log under `<project>/.content-pipeline/runs/`, so the same table can show
 * those rows rather than the operator keeping two tabs open. They are listed, never opened: there is no registry to
 * validate an id against outside Gallivant's own tree, so nothing here builds a path from a query string for them.
 */
const allRuns = (ctx, entries, { entry = null } = {}) => {
  const mine = listRuns(ctx.home, entries, { isRunning: liveness, entry, clock: ctx.clock, maxIterations: ctx.config.max_iterations });
  // A filter names a Gallivant entry, and no foreign run belongs to one, so a filtered list is Gallivant's alone.
  if (entry) return mine;
  const theirs = (ctx.runSources || []).flatMap(s => listFlatRuns(s.dir, { source: s.label, isRunning: liveness, clock: ctx.clock }));
  return [...mine, ...theirs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.run.localeCompare(a.run));
};

/** What the URL asks for about presentation: which palette to force, which grouping, and where we are mounted. */
const viewOf = (url, base = "", home = null) => {
  const by = url.searchParams.get("by") || "";
  return {
    theme: themeOf(url.searchParams.get("theme")),
    by: GROUPINGS.includes(by) ? by : GROUPINGS[0],
    // The raw values, so a link out of one page keeps the reader's choices rather than resetting them.
    query: workspaceQuery(Object.fromEntries(url.searchParams)),
    base,
    home,
  };
};

/**
 * Resolve `?id=` to a registry entry. The query string is never joined to a path: an id is accepted only when the
 * registry has it, so a traversal attempt (`../../etc`, `..%2f..`) simply does not match an entry and is a 404.
 */
const entryFrom = (ctx, url) => {
  const id = url.searchParams.get("id") || "";
  const entry = id ? ctx.state.get(id) : null;
  return entry ? { id, entry } : null;
};

/**
 * Which run a page or a stream is about: `?run=` when the reader picked one from the runs list, otherwise the run
 * this entry last dispatched. A `?run=` that is not a valid run id, or that names no folder, is refused rather than
 * silently falling back to the current run, because a reader following a link deserves to know it was wrong.
 */
const runFor = (ctx, id, wanted) => {
  const runner = executionRunner(ctx, id);
  if (!wanted) { const cur = runner.current(); return cur ? { id: cur.id, exit: cur.exit, running: cur.running, startedAt: cur.startedAt, endedAt: cur.endedAt, execution: cur.execution } : null; }
  if (!validRunId(wanted)) return null;
  const job = runner.read(wanted);
  return job ? { id: job.id, exit: job.exit, running: liveness(job), startedAt: job.startedAt, endedAt: job.endedAt, execution: job.execution } : null;
};

/**
 * Which run directory a log request is about, or null.
 *
 * The two log routes (the live stream and the history window) address a run exactly the same way, so they resolve it
 * the same way, here, once. Two spellings of one rule is how a traversal gets into the second one after the first is
 * fixed: a run from a configured flat tree is addressed by its source label, matched against the configured list; one
 * of Gallivant's own is addressed by a registry entry id and a run id, and the directory is rebuilt from those rather
 * than from the query string. Nothing a query string contains is ever joined to a path as given.
 */
const logDirFor = (ctx, url) => {
  const source = url.searchParams.get("source") || "";
  const wanted = url.searchParams.get("run") || "";
  if (source) {
    const dir = sourceRunDir(ctx.runSources, source, wanted);
    return dir ? { dir, isRunning: job => !!job && job.exit === null && alive(job.pid) } : null;
  }
  const hit = entryFrom(ctx, url);
  if (!hit) return null;
  const run = runFor(ctx, hit.id, wanted);
  if (!run) return null;
  const dir = runDir(ctx.home, ctx.state.entries(), hit.id, run.id);
  return dir ? { dir, id: hit.id, runId: run.id, isRunning: liveness } : null;
};

const workspaceFor = (ctx, id, entry, run, presentation) => {
  const runner = executionRunner(ctx, id);
  const projection = workspaceProjection({ id, entry, run, presentation, capabilities: runner.capabilities, now: ctx.clock?.now() ?? Date.now(), sanitize: run && runner.sanitize ? value => runner.sanitize(value, run.id) : redact });
  return run && runner.sanitize ? runner.sanitize(projection, run.id) : projection;
};

// Shared loopback, origin, token and bounded JSON boundary for task and chain controls.
async function protectedInput(ctx, req, res) {
  if (!localRequest(req) || req.headers.origin !== `http://${req.headers.host}`
    || req.headers["x-gallivant-token"] !== tokenFor(ctx)) return json(res, 403, { error: "Open this page on localhost and reload before trying again." });
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") return json(res, 415, { error: "JSON required" });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 32768) return json(res, 413, { error: "Request too large" });
    chunks.push(Buffer.from(chunk));
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return json(res, 400, { error: "Invalid JSON" }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(res, 400, { error: "Invalid request" });
  return input;
}

// The route table, keyed by method and path, as in command-center's server.mjs. Anything not listed is a 404, and
// GET never changes state; protected writes use the canonical task and chain services.
export const routes = {
  "GET /": (ctx, _req, res, url, v) => html(res, 200, dashboard(model(ctx), { clock: ctx.clock, ...v })),
  "GET /health": (ctx, _req, res, _url, v) => html(res, 200, healthPage(ctx, v)),
  "GET /api/system-health": (ctx, _req, res, _url, v) => json(res, 200, healthSnapshot(ctx, v)),

  "GET /task/new": (ctx, req, res, url, v) => {
    if (!localRequest(req)) return json(res, 403, { error: "Open intake on localhost." });
    let task = null, error = null;
    try { if (url.searchParams.has("task")) task = inspectIntake(ctx, { taskId: url.searchParams.get("task") }); }
    catch (e) { error = intakeError(e).error; }
    html(res, 200, intakePage({ ...v, task, error, capabilities: intakeCapabilities(ctx), token: tokenFor(ctx),
      instance: createHash("sha256").update(ctx.home).digest("hex").slice(0, 24) }));
  },
  "GET /api/task/intake": (ctx, req, res, url, v) => {
    if (!localRequest(req)) return json(res, 403, { error: "Open intake on localhost." });
    try {
      const task = inspectIntake(ctx, Object.fromEntries(url.searchParams));
      json(res, 200, { task, content: intakeReview(task, v) });
    } catch (error) { json(res, 409, intakeError(error)); }
  },
  ...Object.fromEntries(["prepare", "answer", "resume", "validate", "start"].map(action => [`POST /api/task/intake/${action}`, async (ctx, req, res, _url, v) => {
    const input = await protectedInput(ctx, req, res);
    if (!input) return;
    try {
      const owner = acquireCliMutation(ctx.home);
      try {
        const task = await mutateIntake(ctx, action, input, owner);
        json(res, 200, { task, content: intakeReview(task, v) });
      } finally { owner.release(); }
    } catch (error) { json(res, 409, intakeError(error)); }
  }])),

  "GET /chains": (ctx, req, res, _url, v) => html(res, 200, chainsPage(ctx, { ...v, controlToken: localRequest(req) ? tokenFor(ctx) : null })),
  "GET /api/chains": (ctx, req, res, _url, v) => json(res, 200, chainsSnapshot(ctx, { ...v, authorized: localRequest(req) })),
  "POST /api/chain/control": async (ctx, req, res, url) => {
    const input = await protectedInput(ctx, req, res);
    if (!input) return;
    const name = url.searchParams.get("chain") || "";
    if (!ctx.state.getChain(name)) return json(res, 404, { error: "Unknown chain." });
    try {
      const owner = acquireCliMutation(ctx.home);
      try { json(res, 200, redact(await chainControl(ctx, name, input))); }
      finally { owner.release(); }
    } catch (error) {
      // Source parser/host errors may contain file contents or private paths.
      const safe = /^(?:Invalid chain control|Chain (?:changed|is)|chain (?:changed|or inputs changed)|Request identity|A start claim|No undispatched|Retry is|Only active|This namespace|Use the manifest-aware|another .*task mutation)/i.test(error.message);
      json(res, 409, { error: safe ? redact(error.message) : "Recovery review unavailable. Check repository and task identity, approved base, ready briefs and sources with the CLI, then review again. No changes were accepted." });
    }
  },

  "GET /runs": (ctx, _req, res, url, v) => {
    const entries = ctx.state.entries();
    const filter = url.searchParams.get("entry") || "";
    // A filter naming an entry the registry does not have lists nothing rather than everything, so a stale link
    // never quietly widens what it shows.
    const known = filter && entries.some(([id]) => id === filter);
    const rows = filter && !known ? [] : allRuns(ctx, entries, { entry: filter || null });
    // The run the reader picked in the sidebar, matched against the rows already listed rather than resolved from
    // the query string, so `open` can name nothing that is not on this page anyway.
    const want = url.searchParams.get("open") || "", from = url.searchParams.get("source") || "";
    const open = want ? rows.find(r => r.run === want && (r.source || "") === from) || null : null;
    html(res, 200, runsPage(rows, { entry: filter, open, ...v }));
  },

  "GET /run": (ctx, req, res, url, v) => {
    const hit = entryFrom(ctx, url);
    if (!hit) return notFound(res, "No entry with that id. The dashboard lists the ones the registry has.", v);
    const { id, entry } = hit;
    const wanted = url.searchParams.get("run") || "";
    const run = runFor(ctx, id, wanted);
    if (wanted && !run) return notFound(res, "No such run for that entry.", v);
    // The divergence comes off the model's own row rather than being recomputed here: the model is built for this
    // response anyway, and one comparison per request beats two that could disagree.
    const m = model(ctx);
    const row = [...m.needs_you, ...m.running, ...m.done].find(r => r.id === id) || null;
    let initialLaunch = false;
    try { initialLaunch = !!unsubmittedInitialDispatch(entry, executionRunner(ctx, id)); } catch { /* Unresolved or stopped ownership cannot enable a launch control. */ }
    const runner = executionRunner(ctx, id);
    html(res, 200, runPage({ clock: ctx.clock, id, entry, handle: handleFor(id, entry), run, pinned: Boolean(wanted), initialLaunch,
      controlContext: controlView(entry, runner.current(), runner.capabilities, { initialLaunch }),
      controlInstance: createHash("sha256").update(ctx.home).digest("hex").slice(0, 24),
      maxIterations: ctx.config.max_iterations, model: m, workspace: workspaceFor(ctx, id, entry, run, row.presentation), attempts: listRuns(ctx.home, [[id, entry]], { limit: 12, isRunning: liveness, clock: ctx.clock, maxIterations: ctx.config.max_iterations }), divergence: row?.divergence ?? null, controlToken: localRequest(req) ? tokenFor(ctx) : null, ...v }));
  },

  "GET /api/run/workspace": (ctx, _req, res, url, v) => {
    const hit = entryFrom(ctx, url);
    if (!hit) return json(res, 404, { error: "Task no longer registered; last snapshot retained." });
    const wanted = url.searchParams.get("run") || "";
    const run = runFor(ctx, hit.id, wanted);
    if (wanted && !run) return json(res, 404, { error: "Selected attempt unavailable; last snapshot retained." });
    const m = model(ctx);
    const row = [...m.needs_you, ...m.running, ...m.done].find(row => row.id === hit.id);
    const w = workspaceFor(ctx, hit.id, hit.entry, run, row.presentation);
    json(res, 200, workspaceSnapshot(w, { ...v, clock: ctx.clock || Date }));
  },

  "GET /api/run/control": (ctx, _req, res, url) => {
    const hit = entryFrom(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown entry" });
    const runner = executionRunner(ctx, hit.id), run = runner.current();
    let resumable = Boolean(hit.entry.session);
    try { resumable ||= Boolean(unsubmittedInitialDispatch(hit.entry, runner)); } catch { /* Unresolved ownership cannot enable a launch control. */ }
    const requestId = url.searchParams.get("requestId");
    if (requestId !== null && !validControlRequestId(requestId)) return json(res, 400, { error: "Invalid control request identity." });
    const view = controlView(hit.entry, run, runner.capabilities, { initialLaunch: resumable && !hit.entry.session });
    const request = requestId && [hit.entry.control, ...(hit.entry.control_history || [])].find(c => c?.id === requestId);
    json(res, 200, { control: hit.entry.control || null, ...(requestId ? { requestId, request: request || null } : {}),
      lastMessage: lastMessage(hit.entry), state: hit.entry.state, reason: hit.entry.reason, ...redact(view) });
  },

  "GET /api/run/review-activity": (ctx, _req, res, url) => {
    const id = url.searchParams.get("id") || "";
    const entry = id && (ctx.state.reviewActivityEntry ? ctx.state.reviewActivityEntry(id) : ctx.state.get(id));
    if (!entry) return json(res, 404, { error: "unknown entry" });
    json(res, 200, reviewActivity(entry));
  },

  "POST /api/run/control": async (ctx, req, res, url) => {
    const input = await protectedInput(ctx, req, res);
    if (!input) return;
    const hit = entryFrom(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown entry" });
    if (Object.keys(input).some(key => !["action", "note", "interrupt", "requestId"].includes(key))) return json(res, 400, { error: "Unknown control field." });
    try {
      const owner = acquireCliMutation(ctx.home);
      try { json(res, 202, requestControl(ctx, { handle: hit.id, action: input.action, note: input.note, interrupt: input.interrupt, requestId: input.requestId })); }
      finally { owner.release(); }
    }
    catch (e) { json(res, 409, { error: e.message }); }
  },

  // The stylesheet and the script, served rather than inlined so the CSP needs no nonce and no hash. They cannot
  // change under a running server, so they are the one thing here worth caching in the browser.
  "GET /tracker.css": (_ctx, _req, res) => send(res, 200, ASSETS["/tracker.css"].type, ASSETS["/tracker.css"].body, "max-age=60"),
  "GET /tracker.js": (_ctx, _req, res) => send(res, 200, ASSETS["/tracker.js"].type, ASSETS["/tracker.js"].body, "max-age=60"),

  "GET /api/overview": (ctx, _req, res, _url, v) => json(res, 200, overviewSnapshot(model(ctx), { ...v, clock: ctx.clock || Date })),
  "GET /api/status": (ctx, _req, res) => json(res, 200, model(ctx)),
  "GET /api/capabilities": (_ctx, _req, res) => json(res, 200, { version: 1, providers: executionCapabilities() }),

  "GET /api/runs": (ctx, _req, res, url) => {
    const filter = url.searchParams.get("entry") || "";
    json(res, 200, { runs: allRuns(ctx, ctx.state.entries(), { entry: filter || null }) });
  },

  // The live log of a run, as server-sent events.
  //
  // The path is /output rather than /log on purpose. "log?id=" has the shape of a tracking pixel, and content
  // blockers that filter on the URL (uBlock Origin Lite's default rules, via declarativeNetRequest) reject it
  // inside the browser before the request is sent: Chrome reports blocked:other, the server sees nothing at all,
  // and the pane waits on a stream that was never opened. Ordinary fetches to /api/run/status are untouched, which
  // is what made this look like a streaming bug rather than a blocked request.
  "GET /api/run/output": (ctx, req, res, url) => {
    const hit = logDirFor(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown run" });
    streamRun(res, hit.dir, { req, isRunning: hit.isRunning });
  },

  // A window of a run's log, older than what the pane is already showing. A read, not a stream, so it is its own
  // path rather than a mode of /output: the tail on open exists because thousands of lines as individual
  // server-sent events stall the browser until it drops the connection, and answering "give me the previous 400" as
  // one JSON body is the shape that does not have that problem. Same addressing and the same validation as /output,
  // through the same `logDirFor`, so a traversal that fails on one fails on the other by construction.
  //
  // `?before=<id>` is the id of the oldest line the pane has, so the answer is the window before it, and `before` in
  // the answer is how many lines are older still. No `before` means the window the tail did not show.
  "GET /api/run/history": (ctx, _req, res, url) => {
    const hit = logDirFor(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown run" });
    const raw = url.searchParams.get("before");
    // A non-numeric `before` is not a request for the start of the file, it is a broken link, and answering it with
    // the first 400 lines would look like the feature working. Absent is the one case that means "the default".
    if (raw !== null && !/^-?\d+$/.test(raw)) return json(res, 400, { error: "before must be a line number" });
    json(res, 200, { run: url.searchParams.get("run") || "", tail: TAIL, ...sliceRun(hit.dir, { end: raw === null ? null : Number(raw) }) });
  },

  // Kept so an old bookmark or a copied URL still resolves.
  "GET /api/run/log": (_ctx, _req, res, url, v) => { res.writeHead(302, { location: `${v.base}/api/run/output${url.search || ""}`, ...SECURITY }); res.end(); },

  "GET /api/run/status": (ctx, _req, res, url) => {
    const hit = entryFrom(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown entry" });
    const run = runFor(ctx, hit.id, url.searchParams.get("run") || "");
    if (!run) return json(res, 404, { error: "no run" });
    const window = logWindow(executionRunner(ctx, hit.id).dirOf(run.id));
    json(res, 200, { entry: hit.id, run: run.id, running: run.running, exit: run.exit, lines: window.total, last: window.lines.at(-1) || "", ...(window.gap ? { gap: window.gap } : {}) });
  },
  "GET /api/run/result": (ctx, _req, res, url) => {
    const hit = logDirFor(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown run" });
    const result = readJson(join(hit.dir, "result.json"));
    if (!result) return json(res, 404, { error: "result has not been collected" });
    // Private results retain exact ownership and artifacts. Public responses
    // use the summary and the run's supplied-secret redaction, never payloads.
    const artifacts = (Array.isArray(result.artifacts) ? result.artifacts.slice(0, 100)
      : Array.isArray(result.files) ? result.files.slice(0, 100).map(f => ({ path: f.path, hash: f.afterHash })) : [])
      .map(f => ({ path: f.path, hash: f.hash }));
    const execution = hit.id ? executionRunner(ctx, hit.id) : null;
    // The workspace needs artifact metadata, never outcome prose, verification
    // logs or private provider payloads. Keep the existing full evidence link.
    if (url.searchParams.get("view") === "summary") {
      const bounded = v => typeof v === "string" ? (execution?.sanitize ? execution.sanitize(v, hit.runId) : redact(v)).slice(0, 256) : null;
      const summary = { version: result.version, taskId: bounded(result.taskId), runId: bounded(result.runId),
        artifacts: artifacts.map(f => ({ path: bounded(f.path), hash: bounded(f.hash) })) };
      return json(res, 200, execution?.sanitize ? execution.sanitize(summary, hit.runId) : redact(summary));
    }
    const publication = readJson(join(hit.dir, "result-application.json"));
    if (Array.isArray(publication?.paths)) publication.paths = artifacts.map(f => f.path);
    const outcome = execution?.outcome?.(hit.runId) ?? result.outcome;
    const view = { version: result.version, taskId: result.taskId, runId: result.runId, inputHead: result.inputHead ?? null,
      providerJobId: result.providerJobId ?? null, sessionId: result.sessionId ?? null, turnId: result.turnId ?? null,
      outcome, artifacts, publication, verification: readJson(join(hit.dir, "verification.json")) };
    json(res, 200, execution?.sanitize ? execution.sanitize(view, hit.runId) : redact(view));
  },
};

/**
 * Route one request. Exported so the tests can drive every handler with fake request and response objects, and so a
 * host server can delegate a prefix to it (see `mount`).
 *
 * `base` is the mount path to strip from the request and to put back on every URL the pages emit. Empty means this
 * tracker owns the origin, which is what `gallivant serve` does.
 */
export function handle(ctx, req, res, { base = "", home = null } = {}) {
  const url = new URL(req.url, `http://${HOST}`);
  // Under a mount, `/gallivant/runs` is this router's `/runs`, and `/gallivant` itself is its `/`.
  const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : url.pathname;
  const route = routes[`${req.method} ${path}`];
  const view = viewOf(url, base, home);
  if (!route) return path.startsWith("/api/") ? json(res, 404, { error: "not found" }) : notFound(res, `No page at ${esc(url.pathname)}.`, view);
  const failed = e => {
    ctx.log?.warn?.(`serve ${req.method} ${url.pathname}: ${e.message}`);
    // The reader gets the status, never the exception text: a message can carry a path or a token, and this page is
    // the one thing in Gallivant a browser renders.
    if (res.headersSent) return res.end();
    return path.startsWith("/api/")
      ? json(res, 500, { error: "internal error" })
      : html(res, 500, page({ title: "error - gallivant", base: view.base, theme: view.theme, body: `<header class="top"><h1>500</h1></header><main class="main" id="main" tabindex="-1"><p>Something went wrong. The terminal running <code>gallivant serve</code> has the reason.</p></main>` }));
  };
  try {
    const result = route(ctx, req, res, url, view);
    return result?.catch ? result.catch(failed) : result;
  } catch (e) { return failed(e); }
}

/**
 * Mount the tracker inside a server somebody else owns, so one process and one port serve both. The host matches the
 * prefix and hands the request over; everything below that prefix is this router's, including its own 404.
 *
 *   import { mount } from "@uchibeke/gallivant/lib/commands/serve.mjs";
 *   const tracker = mount(makeContext(), { base: "/gallivant" });
 *   createServer((req, res) => {
 *     if (tracker.owns(req)) return tracker.handle(req, res);
 *     ...the host's own routes
 *   }).listen(8790, "127.0.0.1");
 *
 * `home` is an optional `{ label, url }` link back out to the host, so the switch works both ways rather than being a
 * one-way trip into the tracker.
 *
 * The host keeps its own auth and its own bind address. Two things follow from that, and they are the host's to get
 * right rather than something this module can enforce: a host that answers on a public address publishes the
 * tracker there too, and a host with auth should put this behind it, because nothing here asks who is calling.
 */
export function mount(ctx, { base = "/gallivant", home = null } = {}) {
  const prefix = "/" + String(base).replace(/^\/+|\/+$/g, "");
  if (prefix === "/") throw new Error("mount needs a non-empty base path, for example /gallivant");
  return {
    base: prefix,
    /** Whether this request belongs to the tracker: the prefix itself, or anything under it. */
    owns: req => { const p = new URL(req.url, `http://${HOST}`).pathname; return p === prefix || p.startsWith(prefix + "/"); },
    handle: (req, res) => handle(ctx, req, res, { base: prefix, home }),
  };
}

export function serve(ctx, { port = DEFAULT_PORT, instance = null } = {}) {
  const server = createServer((req, res) => {
    if (instance && req.method === "GET" && req.url === "/api/health") return localRequest(req)
      ? json(res, 200, { instance }) : json(res, 403, { error: "local requests only" });
    return handle(ctx, req, res);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // 127.0.0.1, never 0.0.0.0 and never a hostname that could resolve to a LAN address. There is no auth here and
    // the pages show branch names, paths and log output, so reachability from another machine is the whole risk.
    server.listen(port, HOST, () => { ctx.log.info(`serve: http://${HOST}:${port}`); resolve(server); });
  });
}
