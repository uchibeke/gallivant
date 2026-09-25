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
import { isOurProcess } from "../run.mjs";
import { streamRun } from "../tracker/stream.mjs";
import { listRuns, runDir, validRunId } from "../tracker/runs.mjs";
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
const notFound = (res, what, view) => html(res, 404, page({ title: "not found - gallivant", theme: view?.theme, body: `<header class="top"><h1>404</h1></header><section class="main"><p>${esc(what)}</p><p><a href="/">back to the dashboard</a></p></section>` }));

const liveness = job => !!job && job.exit === null && isOurProcess(job.pid, job.bin);

/** What the URL asks for about presentation: which palette to force and which grouping to render. */
const viewOf = url => {
  const by = url.searchParams.get("by") || "";
  return {
    theme: themeOf(url.searchParams.get("theme")),
    by: GROUPINGS.includes(by) ? by : GROUPINGS[0],
    // The raw values, so a link out of one page keeps the reader's choices rather than resetting them.
    query: { theme: themeOf(url.searchParams.get("theme")) || "" },
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
  "GET /": (ctx, _req, res, url) => { const v = viewOf(url); html(res, 200, dashboard(model(ctx), { clock: ctx.clock, ...v })); },

  "GET /runs": (ctx, _req, res, url) => {
    const v = viewOf(url);
    const entries = ctx.state.entries();
    const filter = url.searchParams.get("entry") || "";
    // A filter naming an entry the registry does not have lists nothing rather than everything, so a stale link
    // never quietly widens what it shows.
    const known = filter && entries.some(([id]) => id === filter);
    const rows = filter && !known ? [] : listRuns(ctx.home, entries, { isRunning: liveness, entry: filter || null });
    html(res, 200, runsPage(rows, { entry: filter, ...v }));
  },

  "GET /run": (ctx, _req, res, url) => {
    const v = viewOf(url);
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
    json(res, 200, { runs: listRuns(ctx.home, ctx.state.entries(), { isRunning: liveness, entry: filter || null }) });
  },

  // The live log of a run, as server-sent events.
  //
  // The path is /output rather than /log on purpose. "log?id=" has the shape of a tracking pixel, and content
  // blockers that filter on the URL (uBlock Origin Lite's default rules, via declarativeNetRequest) reject it
  // inside the browser before the request is sent: Chrome reports blocked:other, the server sees nothing at all,
  // and the pane waits on a stream that was never opened. Ordinary fetches to /api/run/status are untouched, which
  // is what made this look like a streaming bug rather than a blocked request.
  "GET /api/run/output": (ctx, req, res, url) => {
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
  "GET /api/run/log": (_ctx, _req, res, url) => { res.writeHead(302, { location: "/api/run/output" + (url.search || ""), ...SECURITY }); res.end(); },

  "GET /api/run/status": (ctx, _req, res, url) => {
    const hit = entryFrom(ctx, url);
    if (!hit) return json(res, 404, { error: "unknown entry" });
    const run = runFor(ctx, hit.id, url.searchParams.get("run") || "");
    if (!run) return json(res, 404, { error: "no run" });
    const lines = ctx.runnerFor(hit.id).lines(run.id);
    json(res, 200, { entry: hit.id, run: run.id, running: run.running, exit: run.exit, lines: lines.length, last: lines.at(-1) || "" });
  },
};

/** Route one request. Exported so the tests can drive every handler with fake request and response objects. */
export function handle(ctx, req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return url.pathname.startsWith("/api/") ? json(res, 404, { error: "not found" }) : notFound(res, `No page at ${url.pathname}.`);
  try { return route(ctx, req, res, url); }
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

export function serve(ctx, { port = DEFAULT_PORT } = {}) {
  const server = createServer((req, res) => handle(ctx, req, res));
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // 127.0.0.1, never 0.0.0.0 and never a hostname that could resolve to a LAN address. There is no auth here and
    // the pages show branch names, paths and log output, so reachability from another machine is the whole risk.
    server.listen(port, HOST, () => { ctx.log.info(`serve: http://${HOST}:${port} (read-only)`); resolve(server); });
  });
}
