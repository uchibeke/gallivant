// `gallivant serve`: the tracker. One local page showing every entry and every run, with the log tailing live.
//
// Read-only, and that is a property of the route table rather than a promise in a comment: only GET is routed, no
// handler writes a file, and there is no route that starts, kills, resets or edits anything. Changing state stays
// the CLI's and the daemon's job, so a page left open in a browser tab (or framed in a dashboard) can do no harm,
// and nothing that reaches this process needs to be trusted with a write.
//
// It binds to 127.0.0.1 and takes no auth, which is the same trust boundary as the CLI: anything that can reach it
// can already read ~/.gallivant. That is exactly why it must never bind to 0.0.0.0.
import { createServer } from "node:http";
import { model } from "./status.mjs";
import { isOurProcess, alive } from "../run.mjs";
import { streamRun } from "../tracker/stream.mjs";
import { listRuns, listFlatRuns, runDir, sourceRunDir, validRunId } from "../tracker/runs.mjs";
import { ASSETS, themeOf } from "../tracker/assets.mjs";
import { dashboard, runPage, runsPage, page, esc, CSP, GROUPINGS } from "../tracker/pages.mjs";

export const DEFAULT_PORT = 8791;
const HOST = "127.0.0.1";

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
  body: `<header class="top"><h1>404</h1></header><section class="main"><p>${esc(what)}</p><p><a href="${esc(view?.base || "")}/">back to the dashboard</a></p></section>` }));

const liveness = job => !!job && job.exit === null && isOurProcess(job.pid, job.bin);

/**
 * Every run the tracker knows about: Gallivant's own, plus any flat run trees the caller pointed it at.
 *
 * `ctx.runSources` is a list of `{ label, dir }`. The point of it is that a run folder is a run folder: command
 * center writes the same job.json and job.log under `<project>/.content-pipeline/runs/`, so the same table can show
 * those rows rather than the operator keeping two tabs open. They are listed, never opened: there is no registry to
 * validate an id against outside Gallivant's own tree, so nothing here builds a path from a query string for them.
 */
const allRuns = (ctx, entries, { entry = null } = {}) => {
  const mine = listRuns(ctx.home, entries, { isRunning: liveness, entry });
  // A filter names a Gallivant entry, and no foreign run belongs to one, so a filtered list is Gallivant's alone.
  if (entry) return mine;
  const theirs = (ctx.runSources || []).flatMap(s => listFlatRuns(s.dir, { source: s.label, isRunning: liveness }));
  return [...mine, ...theirs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.run.localeCompare(a.run));
};

/** What the URL asks for about presentation: which palette to force, which grouping, and where we are mounted. */
const viewOf = (url, base = "", home = null) => {
  const by = url.searchParams.get("by") || "";
  return {
    theme: themeOf(url.searchParams.get("theme")),
    by: GROUPINGS.includes(by) ? by : GROUPINGS[0],
    // The raw values, so a link out of one page keeps the reader's choices rather than resetting them.
    query: { theme: themeOf(url.searchParams.get("theme")) || "" },
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
  const runner = ctx.runnerFor(id);
  if (!wanted) { const cur = runner.current(); return cur ? { id: cur.id, exit: cur.exit, running: cur.running } : null; }
  if (!validRunId(wanted)) return null;
  const job = runner.read(wanted);
  return job ? { id: job.id, exit: job.exit, running: liveness(job) } : null;
};

const handleOf = (id, e) => (e.pr ? `${e.repo.split("/")[1] || e.repo}#${e.pr}` : id);

// The route table, keyed by method and path, as in command-center's server.mjs. Anything not listed is a 404, and
// only GET is listed, which is the read-only rule stated as code.
export const routes = {
  "GET /": (ctx, _req, res, url, v) => html(res, 200, dashboard(model(ctx), { clock: ctx.clock, ...v })),

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

  "GET /run": (ctx, _req, res, url, v) => {
    const hit = entryFrom(ctx, url);
    if (!hit) return notFound(res, "No entry with that id. The dashboard lists the ones the registry has.", v);
    const { id, entry } = hit;
    const wanted = url.searchParams.get("run") || "";
    const run = runFor(ctx, id, wanted);
    if (wanted && !run) return notFound(res, "No such run for that entry.", v);
    html(res, 200, runPage({ id, entry, handle: handleOf(id, entry), run, maxIterations: ctx.config.max_iterations, model: model(ctx), ...v }));
  },

  // The stylesheet and the script, served rather than inlined so the CSP needs no nonce and no hash. They cannot
  // change under a running server, so they are the one thing here worth caching in the browser.
  "GET /tracker.css": (_ctx, _req, res) => send(res, 200, ASSETS["/tracker.css"].type, ASSETS["/tracker.css"].body, "max-age=60"),
  "GET /tracker.js": (_ctx, _req, res) => send(res, 200, ASSETS["/tracker.js"].type, ASSETS["/tracker.js"].body, "max-age=60"),

  "GET /api/status": (ctx, _req, res) => json(res, 200, model(ctx)),

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
    // A run from a configured flat tree has no registry entry, so it is addressed by its source label instead. The
    // label is matched against the configured list, never joined to a path as given.
    const source = url.searchParams.get("source") || "";
    if (source) {
      const dir = sourceRunDir(ctx.runSources, source, url.searchParams.get("run") || "");
      if (!dir) return json(res, 404, { error: "unknown run" });
      return streamRun(res, dir, { req, isRunning: job => !!job && job.exit === null && alive(job.pid) });
    }
    const hit = entryFrom(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown entry" });
    const run = runFor(ctx, hit.id, url.searchParams.get("run") || "");
    if (!run) return json(res, 404, { error: "unknown run" });
    // The directory is rebuilt from the registry id and a validated run id, never from the query string itself.
    const dir = runDir(ctx.home, ctx.state.entries(), hit.id, run.id);
    if (!dir) return json(res, 404, { error: "unknown run" });
    streamRun(res, dir, { req, isRunning: liveness });
  },

  // Kept so an old bookmark or a copied URL still resolves.
  "GET /api/run/log": (_ctx, _req, res, url, v) => { res.writeHead(302, { location: `${v.base}/api/run/output${url.search || ""}`, ...SECURITY }); res.end(); },

  "GET /api/run/status": (ctx, _req, res, url) => {
    const hit = entryFrom(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown entry" });
    const run = runFor(ctx, hit.id, url.searchParams.get("run") || "");
    if (!run) return json(res, 404, { error: "no run" });
    const lines = ctx.runnerFor(hit.id).lines(run.id);
    json(res, 200, { entry: hit.id, run: run.id, running: run.running, exit: run.exit, lines: lines.length, last: lines.at(-1) || "" });
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
  try { return route(ctx, req, res, url, view); }
  catch (e) {
    ctx.log?.warn?.(`serve ${req.method} ${url.pathname}: ${e.message}`);
    // The reader gets the status, never the exception text: a message can carry a path or a token, and this page is
    // the one thing in Gallivant a browser renders.
    if (res.headersSent) return res.end();
    return url.pathname.startsWith("/api/")
      ? json(res, 500, { error: "internal error" })
      : html(res, 500, page({ title: "error - gallivant", body: `<header class="top"><h1>500</h1></header><section class="main"><p>Something went wrong. The terminal running <code>gallivant serve</code> has the reason.</p></section>` }));
  }
}

/**
 * Mount the tracker inside a server somebody else owns, so one process and one port serve both. The host matches the
 * prefix and hands the request over; everything below that prefix is this router's, including its own 404.
 *
 *   import { mount } from "gallivant/lib/commands/serve.mjs";
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

export function serve(ctx, { port = DEFAULT_PORT } = {}) {
  const server = createServer((req, res) => handle(ctx, req, res));
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // 127.0.0.1, never 0.0.0.0 and never a hostname that could resolve to a LAN address. There is no auth here and
    // the pages show branch names, paths and log output, so reachability from another machine is the whole risk.
    server.listen(port, HOST, () => { ctx.log.info(`serve: http://${HOST}:${port} (read-only)`); resolve(server); });
  });
}
