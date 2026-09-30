// The tracker, driven through its route handlers with fake request and response objects. No server is bound to a
// port here: `handle` is the whole of the routing, so calling it directly tests exactly what a browser reaches.
//
// The cases are the ones that would otherwise reach a browser as a bug: a log that restarts from line 1 on every
// reconnect, a pane that stalls at five minutes, a `<script>` in a PR reason that runs, a query string that reads a
// file outside the run tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { handle, mount } from "../lib/commands/serve.mjs";
import { listRuns, listFlatRuns, runDir } from "../lib/tracker/runs.mjs";
import { streamRun, TAIL } from "../lib/tracker/stream.mjs";
import { esc, CSP } from "../lib/tracker/pages.mjs";
import { makeRunner } from "../lib/run.mjs";
import { makeState, newEntry, idSlug, STATES } from "../lib/state.mjs";
import { CONFIG, T0, tempHome, makeClock, silentLog } from "./helpers.mjs";

/** A fake response: records the status, the headers and the body, and resolves `ended` when the handler is done. */
function res() {
  const r = new EventEmitter();
  r.chunks = [];
  r.headersSent = false;
  r.writeHead = (code, headers = {}) => { r.code = code; r.headers = headers; r.headersSent = true; return r; };
  r.write = text => { r.chunks.push(text); return true; };
  r.ended = new Promise(done => { r.end = body => { if (body) r.chunks.push(body); r.emit("close"); done(); }; });
  r.body = () => r.chunks.join("");
  return r;
}

/** A fake response that parses SSE frames, as command-center's run_stream test does. */
function sink() {
  const r = res();
  const frames = [];
  r.write = text => {
    if (text.startsWith(":")) return true;                     // a keepalive comment carries no event
    const named = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(text);
    if (named) { frames.push({ event: named[1], value: named[2] }); return true; }
    const m = /^(?:id: (\d+)\n)?data: (.*)\n\n$/s.exec(text);
    frames.push({ id: m[1], value: JSON.parse(m[2]) });
    return true;
  };
  r.frames = frames;
  r.lines = () => frames.filter(f => !f.event && !String(f.value).startsWith("[")).map(f => f.value);
  return r;
}

const req = (url, headers = {}) => ({ method: "GET", url, headers, socket: { setTimeout() {} }, setTimeout() {} });

const ID = "acme/widget/widget-export";

const localHeaders = { host: "127.0.0.1:8791", origin: "http://127.0.0.1:8791", "content-type": "application/json" };
const localSocket = { remoteAddress: "127.0.0.1", localPort: 8791, setTimeout() {} };

test("local run controls queue through the mounted route and reject duplicate clicks", async () => {
  const w = world({ entry: { state: STATES.needsHuman, reason: "checks-red" } });
  const mounted = mount(w.ctx);
  const page = res();
  mounted.handle({ ...req(`/gallivant/run?id=${encodeURIComponent(ID)}`, localHeaders), socket: localSocket }, page);
  const token = /data-token="([a-f0-9]+)"/.exec(page.body())?.[1];
  assert.ok(token);
  assert.match(page.body(), /Recheck PR/);
  assert.match(page.body(), /data-action="resume"[^>]*>Resume agent<\/button>/);
  assert.match(page.body(), /<form id="message-form"[\s\S]*data-action="message"[^>]*>Send message<\/button>/);
  assert.match(page.body(), /Delivered in the next run of this session/);
  async function post() {
    const request = Readable.from([JSON.stringify({ action: "recheck" })]);
    Object.assign(request, { method: "POST", url: `/gallivant/api/run/control?id=${encodeURIComponent(ID)}`, headers: { ...localHeaders, "x-gallivant-token": token }, socket: localSocket });
    const response = res();
    await mounted.handle(request, response); await response.ended;
    return response;
  }
  assert.equal((await post()).code, 202);
  assert.equal(w.state.get(ID).control.status, "queued");
  assert.equal(w.state.get(ID).state, STATES.needsHuman, "HTTP does not run the recovery itself");
  assert.equal((await post()).code, 409);
});

test("run controls refuse remote peers, rebinding, cross-origin forms and missing CSRF tokens", async () => {
  const w = world();
  const page = res();
  handle(w.ctx, { ...req(`/run?id=${encodeURIComponent(ID)}`, localHeaders), socket: localSocket }, page);
  const token = /data-token="([a-f0-9]+)"/.exec(page.body())[1];
  for (const change of [
    { headers: { ...localHeaders, "x-gallivant-token": "wrong" } },
    { headers: { ...localHeaders, "x-gallivant-token": token, origin: "https://evil.example" } },
    { headers: { ...localHeaders, "x-gallivant-token": token, host: "evil.example:8791", origin: "http://evil.example:8791" } },
    { headers: { ...localHeaders, "x-gallivant-token": token, origin: undefined } },
    { socket: { ...localSocket, remoteAddress: "192.168.1.10" } },
    { socket: { ...localSocket, localPort: 9999 } },
  ]) {
    const request = Readable.from(['{"action":"resume","note":"do something"}']);
    Object.assign(request, { method: "POST", url: `/api/run/control?id=${encodeURIComponent(ID)}`, headers: { ...localHeaders, "x-gallivant-token": token }, socket: localSocket, ...change });
    const response = res(); await handle(w.ctx, request, response); await response.ended;
    assert.equal(response.code, 403);
    assert.equal(w.state.get(ID).control, undefined);
  }
  const remotePage = res();
  handle(w.ctx, { ...req(`/run?id=${encodeURIComponent(ID)}`, localHeaders), socket: { ...localSocket, remoteAddress: "192.168.1.10" } }, remotePage);
  assert.doesNotMatch(remotePage.body(), /data-token=/);
});

test("invalid, oversized and unknown-target control requests never write state", async () => {
  const w = world();
  const page = res();
  handle(w.ctx, { ...req(`/run?id=${encodeURIComponent(ID)}`, localHeaders), socket: localSocket }, page);
  const token = /data-token="([a-f0-9]+)"/.exec(page.body())[1];
  for (const [body, target, contentType, code] of [
    ["{", ID, "application/json", 400],
    ["null", ID, "application/json", 400],
    ["x".repeat(32769), ID, "application/json", 413],
    ['{"action":"recheck"}', "../../etc", "application/json", 404],
    ['{"action":"recheck"}', ID, "text/plain", 415],
    ['{"action":"shell"}', ID, "application/json", 409],
    ['{"action":"message","note":" "}', ID, "application/json", 409],
    ['{"action":"resume","note":"unsent draft"}', ID, "application/json", 409],
  ]) {
    const request = Readable.from([body]);
    Object.assign(request, { method: "POST", url: `/api/run/control?id=${encodeURIComponent(target)}`, headers: { ...localHeaders, "content-type": contentType, "x-gallivant-token": token }, socket: localSocket });
    const response = res(); await handle(w.ctx, request, response); await response.ended;
    assert.equal(response.code, code); assert.equal(w.state.get(ID).control, undefined);
  }
});

/**
 * A home with a registry and a run tree on disk. `runs` maps a run id to { lines, exit, pid }, written exactly as
 * `lib/run.mjs` writes them, so the viewer is reading the real layout and not a shape invented for the test.
 */
function world({ entry = {}, runs = {}, latest = null, entries = {} } = {}) {
  const home = tempHome();
  const state = makeState(home);
  const clock = makeClock();
  state.put(ID, {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111",
      repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/tmp/wt", pr: 142, state: STATES.prOpen, nowIso: T0 }),
    url: "https://github.com/acme/widget/pull/142", ...entry,
  });
  for (const [id, e] of Object.entries(entries)) state.put(id, e);
  const root = join(home, "runs", idSlug(ID));
  for (const [runId, spec] of Object.entries(runs)) {
    const dir = join(root, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job.log"), (spec.lines || []).map(l => l + "\n").join(""));
    writeFileSync(join(dir, "job.json"), JSON.stringify({
      id: runId, name: "fix", pid: spec.pid ?? 424242, bin: spec.bin ?? "/bin/claude",
      startedAt: spec.startedAt ?? Date.parse(T0), exit: spec.exit ?? null,
      ...(spec.endedAt === undefined ? {} : { endedAt: spec.endedAt }),
    }));
  }
  if (latest) writeFileSync(join(root, "latest-run"), latest);
  // The real runner, so liveness, dirOf and the id pattern are the ones production uses. Only its process probe is
  // faked: the test decides which pids are live, since no harness is running.
  const live = new Set(Object.values(runs).filter(s => s.live).map(s => s.pid ?? 424242));
  const ctx = {
    home, state, log: silentLog, config: { ...CONFIG, home },
    runnerFor: () => makeRunner(root, { probe: pid => live.has(pid) }),
    clock,
  };
  return { home, ctx, state, root, clock };
}

test("the dashboard groups every entry the way status already groups them, and links each to its log", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["hello"], exit: 0, endedAt: Date.parse(T0) + 4000 } }, latest: "2026-09-24T02-00-00-000-fix" });
  w.state.put("acme/widget/other", { ...w.state.get(ID), pr: 7, state: STATES.needsHuman, reason: "conflict" });
  w.state.put("acme/widget/shipped", { ...w.state.get(ID), pr: 9, state: STATES.done });
  const r = res();
  handle(w.ctx, req("/"), r);
  await r.ended;
  assert.equal(r.code, 200);
  const body = r.body();
  assert.match(body, /<h2>needs you<\/h2>/);
  assert.match(body, /<h2>running<\/h2>/);
  assert.match(body, /<h2>done<\/h2>/);
  assert.match(body, /widget#7/, "the needs-human entry is listed");
  assert.match(body, /conflict/, "with the reason status would show");
  assert.match(body, /href="\/run\?id=acme%2Fwidget%2Fwidget-export"/, "every row links to its run page");
  assert.match(body, /daemon has never run here/, "no daemon.json says so plainly rather than implying health");
});

test("the run page shows the entry's facts and the log pane, and 404s for an id the registry does not have", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["working"], live: true } }, latest: "2026-09-24T02-00-00-000-fix" });
  const ok = res();
  handle(w.ctx, req(`/run?id=${encodeURIComponent(ID)}`), ok);
  await ok.ended;
  assert.equal(ok.code, 200);
  const body = ok.body();
  for (const fact of ["widget#142", "pr-open", "claude", "round 0/3", "gallivant/widget-export", "6f1c2d3e-1111-4111-8111-111111111111", "https://github.com/acme/widget/pull/142"])
    assert.ok(body.includes(fact), `the header shows ${fact}`);
  assert.match(body, /id="log" data-entry="acme\/widget\/widget-export" data-run="2026-09-24T02-00-00-000-fix"/, "the pane names the run for the script to stream");
  assert.match(body, /<script src="\/tracker\.js" defer><\/script>/, "the script is a separate route, not inline");

  const missing = res();
  handle(w.ctx, req("/run?id=acme/widget/nope"), missing);
  await missing.ended;
  assert.equal(missing.code, 404);

  const badRun = res();
  handle(w.ctx, req(`/run?id=${encodeURIComponent(ID)}&run=2026-01-01T00-00-00-000-ghost`), badRun);
  await badRun.ended;
  assert.equal(badRun.code, 404, "a run that is not in this entry's folder is not shown");
});

test("the sidebar lists every entry in a collapsible group with a count, on both views", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["x"], live: true } }, latest: "2026-09-24T02-00-00-000-fix" });
  w.state.put("acme/widget/stuck", { ...w.state.get(ID), pr: 7, state: STATES.needsHuman, reason: "conflict", harness: "codex" });
  w.state.put("acme/widget/shipped", { ...w.state.get(ID), pr: 9, state: STATES.done, harness: "codex" });

  for (const path of ["/", "/runs", `/run?id=${encodeURIComponent(ID)}`]) {
    const r = res();
    handle(w.ctx, req(path), r);
    await r.ended;
    const body = r.body();
    assert.match(body, /<aside id="side" data-view="(entries|runs)">/, `${path} has a sidebar the script can find`);
    assert.match(body, /<input type="search" id="filter"/, `${path} has one filter input`);
    assert.match(body, /<div class="group" data-group="/, `${path} groups its rows`);
    assert.match(body, /<h3><i class="caret"><\/i><span class="n">[^<]*<\/span><small>\d+<\/small><\/h3>/, `${path} shows a count per group`);
  }

  const dash = res();
  handle(w.ctx, req("/"), dash);
  await dash.ended;
  const body = dash.body();
  // The groups are the sections status already uses, each with the number of rows in it.
  const groups = [...body.matchAll(/data-group="([^"]+)">\s*<h3><i class="caret"><\/i><span class="n">([^<]*)<\/span><small>(\d+)<\/small>/g)]
    .map(([, key, label, n]) => [key, label, Number(n)]);
  assert.deepEqual(groups, [["needs_you", "needs you", 1], ["running", "running", 1], ["done", "done", 1]]);
  // Every row in the sidebar is a link to that entry's page, carrying text a filter can match on.
  const rows = [...body.matchAll(/<a class="row" href="([^"]+)"[^>]*data-hay="([^"]*)"/g)];
  assert.equal(rows.length, 3, "one row per entry");
  assert.ok(rows.every(([, href]) => href.startsWith("/run?id=")), "each row opens that entry");
  assert.ok(rows.some(([, , hay]) => hay.includes("conflict")), "the reason is searchable even where the row does not show it");
  assert.ok(rows.some(([, , hay]) => hay.includes("codex")), "so is the harness");

  // The current entry is marked, so the sidebar shows where you are.
  const one = res();
  handle(w.ctx, req(`/run?id=${encodeURIComponent(ID)}`), one);
  await one.ended;
  const current = [...one.body().matchAll(/<a class="row" href="([^"]+)" aria-current="page"/g)];
  assert.equal(current.length, 1, "exactly one row is the current one");
  assert.match(current[0][1], /id=acme%2Fwidget%2Fwidget-export/);
});

test("the sidebar script persists collapsed state and lets a filter override it", async () => {
  const w = world();
  const r = res();
  handle(w.ctx, req("/tracker.js"), r);
  await r.ended;
  const js = r.body();
  // The detail that makes the filter feel right: while a term is present, collapsed state is not consulted, so a
  // match inside a closed group is shown rather than reading as "no results".
  assert.match(js, /const shut = term \? \{\} : closed\(\)/, "a filter ignores collapsed state");
  assert.match(js, /localStorage/, "collapsed state survives a reload");
  assert.match(js, /gallivant\.tracker\.collapsed:/, "the key is namespaced");
  assert.match(js, /side\.dataset\.view/, "and is per view, so the two views remember their own groups");
  // Reading or writing localStorage can throw, not only return null (a private window, or a partitioned frame).
  assert.match(js, /try \{[^}]*localStorage\.getItem/s);
  assert.match(js, /try \{[^}]*localStorage\.setItem/s);
  // Rows are filtered by their own text, and a group with no match is hidden rather than left as an empty heading.
  assert.match(js, /row\.hidden = !hit/);
  assert.match(js, /g\.hidden = rows\.length > 0 && hits === 0/);
  // No inline handler anywhere: every listener is attached here, which is what lets the CSP forbid inline script.
  assert.match(js, /addEventListener\("click"/);
  assert.match(js, /addEventListener\("input"/);
});

test("grouping switches between state and harness, and nothing else", async () => {
  const w = world();
  w.state.put("acme/widget/stuck", { ...w.state.get(ID), pr: 7, state: STATES.needsHuman, reason: "conflict", harness: "codex" });

  const byState = res();
  handle(w.ctx, req("/"), byState);
  await byState.ended;
  assert.match(byState.body(), /data-group="needs_you"/, "state is the default, matching what the dashboard leads with");
  assert.match(byState.body(), /<option value="state" selected>/);

  const byHarness = res();
  handle(w.ctx, req("/?by=harness"), byHarness);
  await byHarness.ended;
  const body = byHarness.body();
  assert.match(body, /data-group="harness:claude"/);
  assert.match(body, /data-group="harness:codex"/);
  assert.ok(!/data-group="needs_you"/.test(body), "grouping by harness replaces the state groups, it does not add to them");
  assert.match(body, /<option value="harness" selected>/, "the switch shows which grouping is active");
  // The grouping rides on the links, so clicking through the sidebar keeps it.
  assert.match(body, /href="\/run\?by=harness&amp;id=[^"]*"/, "an entry link keeps the grouping");
  assert.match(body, /href="\/runs\?by=harness"/, "so does the nav");

  // Two options, no more: the switch is a small enumeration, not a grouping engine.
  const options = [...body.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(options, ["state", "harness"]);

  // A grouping nobody offers falls back to the default rather than rendering an empty sidebar.
  const junk = res();
  handle(w.ctx, req("/?by=" + encodeURIComponent("'; drop--")), junk);
  await junk.ended;
  assert.match(junk.body(), /data-group="needs_you"/);
  assert.ok(!junk.body().includes("drop--"), "and is not echoed into the page");

  // The runs view groups by the same two, bucketed by outcome rather than by entry state. The route asks the OS
  // whether a pid is alive, so the live row is this test process, whose command really does name the binary.
  const runs = world({ runs: {
    "2026-09-24T02-00-00-000-a": { lines: ["a"], exit: 0, startedAt: 1, endedAt: 2 },
    "2026-09-24T03-00-00-000-b": { lines: ["b"], exit: 1, startedAt: 3, endedAt: 4 },
    "2026-09-24T04-00-00-000-c": { lines: ["c"], exit: null, pid: process.pid, bin: process.execPath, startedAt: 5 },
  } });
  const rr = res();
  handle(runs.ctx, req("/runs"), rr);
  await rr.ended;
  const buckets = [...rr.body().matchAll(/data-group="(runs:[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(buckets, ["runs:running", "runs:failed", "runs:done"], "running first, because that is what a reader is looking for");
  const rh = res();
  handle(runs.ctx, req("/runs?by=harness"), rh);
  await rh.ended;
  assert.match(rh.body(), /data-group="harness:claude"/);
});

test("?theme forces the palette, because prefers-color-scheme in an iframe follows the browser and not the parent", async () => {
  const w = world();
  for (const theme of ["dark", "light"]) {
    const r = res();
    handle(w.ctx, req(`/?theme=${theme}`), r);
    await r.ended;
    assert.match(r.body(), new RegExp(`<html lang="en" data-theme="${theme}">`), `?theme=${theme} stamps the root element`);
    // And it rides along on every link, or clicking through would drop back to the system palette.
    assert.match(r.body(), new RegExp(`href="/runs\\?theme=${theme}"`));
  }

  const none = res();
  handle(w.ctx, req("/"), none);
  await none.ended;
  assert.match(none.body(), /<html lang="en">/, "with no theme asked for, the choice is left to prefers-color-scheme");

  // Anything that is not one of the two is ignored rather than echoed, which is both safer and the right fallback.
  const junk = res();
  handle(w.ctx, req(`/?theme=${encodeURIComponent('" onload="alert(1)')}`), junk);
  await junk.ended;
  assert.match(junk.body(), /<html lang="en">/);
  assert.ok(!junk.body().includes("onload="), "a junk theme is never interpolated into the page");
});

test("the stylesheet is a served file whose every value is a custom property a host page can override", async () => {
  const w = world();
  const r = res();
  handle(w.ctx, req("/tracker.css"), r);
  await r.ended;
  assert.equal(r.code, 200);
  assert.match(r.headers["content-type"], /text\/css/);
  const css = r.body();
  for (const prop of ["--gv-canvas", "--gv-surface", "--gv-text", "--gv-accent", "--gv-font", "--gv-mono", "--gv-size", "--gv-line", "--gv-r"])
    assert.ok(css.includes(prop + ":"), `${prop} has a default a parent can override`);
  // The palette matches the host it is built to sit inside, so a mounted tracker is not a foreign page in a frame.
  assert.match(css, /--gv-accent: #22d3ee/, "the accent is the host's cyan, not a second brand");
  assert.match(css, /--gv-font: Inter,/);
  // `?theme=light` is the opt-out, since the default is the host's dark canvas.
  assert.match(css, /:root\[data-theme="light"\]/);
  // No fixed viewport assumption: the layout is a grid that collapses, and nothing is sized in vw or positioned fixed.
  assert.ok(!/\d+vw/.test(css), "no width is tied to the viewport, since the frame decides the width");
  assert.ok(!/position:\s*fixed/.test(css), "nothing is pinned to the viewport inside a frame");
  // And the CSP can forbid inline styles, because there are none to allow.
  assert.match(CSP, /style-src 'self'/);
});

test("/api/status is exactly the model status renders, so a UI and the CLI cannot disagree", async () => {
  const w = world();
  const r = res();
  handle(w.ctx, req("/api/status"), r);
  await r.ended;
  assert.equal(r.code, 200);
  const { model } = await import("../lib/commands/status.mjs");
  assert.deepEqual(JSON.parse(r.body()), JSON.parse(JSON.stringify(model(w.ctx))));
});

test("an unknown path is a 404, an HTML page for a reader and JSON for a caller", async () => {
  const w = world();
  const pageMiss = res();
  handle(w.ctx, req("/dashboard"), pageMiss);
  await pageMiss.ended;
  assert.equal(pageMiss.code, 404);
  assert.match(pageMiss.headers["content-type"], /text\/html/);

  const apiMiss = res();
  handle(w.ctx, req("/api/nothing"), apiMiss);
  await apiMiss.ended;
  assert.equal(apiMiss.code, 404);
  assert.deepEqual(JSON.parse(apiMiss.body()), { error: "not found" });

  // Only GET is routed at all, which is the read-only rule as code: a POST matches nothing.
  const post = res();
  handle(w.ctx, { ...req("/"), method: "POST" }, post);
  await post.ended;
  assert.equal(post.code, 404, "no method but GET reaches a handler");
});

test("every page carries a content-security-policy that allows no inline script", async () => {
  const w = world();
  const r = res();
  handle(w.ctx, req("/"), r);
  await r.ended;
  const csp = r.headers["content-security-policy"];
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/unsafe-inline[^;]*script|script[^;]*unsafe-inline/.test(csp), "script-src must never allow inline code");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors [^;]*'self'/, "the page is meant to be framed by a local dashboard");
  assert.equal(r.headers["x-content-type-options"], "nosniff");

  const js = res();
  handle(w.ctx, req("/tracker.js"), js);
  await js.ended;
  assert.equal(js.code, 200);
  assert.match(js.headers["content-type"], /javascript/);
  // A log line becomes markup on purpose now, so tool calls and links can be told apart (the renderer is ported
  // from command-center's logline.js). What keeps that safe is that the text is escaped before anything is built
  // from it, and only markup this file wrote is ever inserted. The escape must therefore come first.
  assert.match(js.body(), /const esc = s => String\(s\)\.replace/, "the renderer carries its own escaper");
  assert.match(js.body(), /let html = esc\(text\);/, "text is escaped before any link is substituted into it");
  // Anything the page writes as plain text still goes through textContent.
  assert.match(js.body(), /el\.textContent = text/);
});

test("log lines render as structured rows, the way command-center renders them, and stay inert", async () => {
  // The renderer is ported from command-center's public/logline.js, so a Gallivant log reads the same way there:
  // tool calls in their own column, links shortened, the closing line coloured by outcome. This test drives the
  // ported functions directly out of the served script, which is the only copy that reaches a browser.
  const w = world();
  const r = res();
  handle(w.ctx, req("/tracker.js"), r);
  await r.ended;
  const src = r.body();
  const { renderLine } = new Function(src.slice(src.indexOf("const esc = s =>")) + "; return { renderLine };")();

  assert.equal(renderLine("  WebSearch: quiet hotels"), '<div class="ll t search"><span class="n">WebSearch</span><span class="a">quiet hotels</span></div>');
  assert.equal(renderLine("  Bash: npm test"), '<div class="ll t shell"><span class="n">Bash</span><span class="a">npm test</span></div>');
  assert.match(renderLine("done in 42s"), /class="ll d ok"/);
  assert.match(renderLine("failed after 3s: boom"), /class="ll d bad"/);
  assert.match(renderLine("see https://github.com/acme/widget/pull/142"), /<a href="https:\/\/github\.com\/acme\/widget\/pull\/142" target="_blank" rel="noopener noreferrer">github\.com\/142<\/a>/);

  // Every line is agent output, so the escape has to hold whatever it contains. Parse what the renderer produced
  // and check the DOM it would build: no tag but the three this file writes, no event handler, no non-http href.
  for (const hostile of [
    "<script>alert(1)</script>",
    "  Bash: <img src=x onerror=alert(1)>",
    "  <script>x</script>: arg",
    "done in 1s <script>alert(1)</script>",
    `see http://evil.com/"onmouseover="alert(1)`,
    "  A: \" onload=\"alert(1)",
    "javascript:alert(1)",
  ]) {
    const html = renderLine(hostile);
    for (const [, name, attrs] of html.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
      assert.ok(["div", "span", "a"].includes(name), `${JSON.stringify(hostile)} produced a <${name}>`);
      const pairs = [...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(m => m[1]);
      assert.ok(!pairs.some(k => /^on/i.test(k)), `${JSON.stringify(hostile)} produced an event handler: ${attrs}`);
      const href = /href="([^"]*)"/.exec(attrs);
      assert.ok(!href || /^https?:/.test(href[1]), `${JSON.stringify(hostile)} produced a non-http href`);
    }
    assert.ok(!/<script/i.test(html), `${JSON.stringify(hostile)} produced a script tag`);
  }
});

test("hostile text in a reason or a log line is escaped, not rendered", async () => {
  const payload = `<script>alert("xss")</script>`;
  const w = world({
    entry: { state: STATES.needsHuman, reason: payload, branch: `feature/"><img src=x onerror=alert(1)>` },
    runs: { "2026-09-24T02-00-00-000-fix": { lines: [payload, `<img src=x onerror="alert(2)">`], exit: 1, endedAt: Date.parse(T0) + 1000 } },
    latest: "2026-09-24T02-00-00-000-fix",
  });

  for (const path of ["/", `/run?id=${encodeURIComponent(ID)}`]) {
    const r = res();
    handle(w.ctx, req(path), r);
    await r.ended;
    const body = r.body();
    assert.ok(body.includes("&lt;script&gt;alert"), `${path} shows the payload as text, escaped`);
    // The property that matters is not "the bytes are absent" but "no tag came from the payload". So read every tag
    // the browser would see and check it against what the templates write: the payload's img and script are gone,
    // and no tag anywhere carries an event handler.
    const tags = [...body.matchAll(/<\/?([a-zA-Z][\w-]*)\b([^>]*)>/g)];
    const injected = tags.filter(([, name]) => ["img", "iframe", "object", "embed", "svg"].includes(name.toLowerCase()));
    assert.deepEqual(injected, [], `${path} renders no tag the payload asked for`);
    const handlers = tags.filter(([, , attrs]) => /\bon[a-z]+\s*=/i.test(attrs));
    assert.deepEqual(handlers.map(t => t[0]), [], `${path} has no inline event handler, on a tag of ours or theirs`);
    // The only script element on the page is the one that loads /tracker.js, with no body of its own.
    const scripts = tags.filter(([, name]) => name.toLowerCase() === "script");
    assert.ok(scripts.every(([tag]) => tag === "</script>" || /^<script src="\/tracker\.js" defer>$/.test(tag)), `${path} has no script but /tracker.js`);
  }

  // A log line reaches the browser as a JSON string in an SSE frame and is inserted with textContent, so the escape
  // that matters for it is that it never becomes markup. Assert the frame carries it verbatim, and the page does not.
  const s = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, {}), s);
  await s.ended;
  assert.deepEqual(s.lines(), [payload, `<img src=x onerror="alert(2)">`], "the stream carries the bytes the agent printed");
  assert.equal(esc(payload), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
});

test("a path-traversal id reads nothing: ids are matched against the registry, never joined to a path", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["secret"], exit: 0, endedAt: Date.parse(T0) + 10 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const hostile = [
    "../../../../etc/passwd",
    "..%2f..%2f..%2fetc%2fpasswd",
    "acme/widget/../../../../etc",
    "/etc/passwd",
    "acme/widget/widget-export/../../..",
  ];
  for (const id of hostile) {
    for (const path of [`/run?id=${encodeURIComponent(id)}`, `/api/run/output?id=${encodeURIComponent(id)}`, `/api/run/status?id=${encodeURIComponent(id)}`]) {
      const r = res();
      handle(w.ctx, req(path), r);
      await r.ended;
      assert.equal(r.code, 404, `${path} must be refused`);
      assert.ok(!r.body().includes("root:"), "nothing outside the run tree is ever read");
    }
  }

  // The same for the run id, which is the half that does get joined to a path once the entry is known.
  for (const run of ["../../../../etc/passwd", "..", ".", "a/../b"]) {
    const r = res();
    handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}&run=${encodeURIComponent(run)}`), r);
    await r.ended;
    assert.equal(r.code, 404, `run=${run} must be refused`);
    assert.equal(runDir(w.home, w.state.entries(), ID, run), null, "runDir refuses it too, so no caller can reach it");
  }
  // And an entry id that is not registered resolves to no directory even with a legitimate run id.
  assert.equal(runDir(w.home, w.state.entries(), "acme/widget/not-registered", "2026-09-24T02-00-00-000-fix"), null);
});

test("the runs list is every run folder on disk, newest first, filterable by entry", async () => {
  const w = world({
    runs: {
      "2026-09-24T02-00-00-000-start": { lines: ["one"], exit: 0, startedAt: 1000, endedAt: 4500 },
      "2026-09-24T03-00-00-000-fix": { lines: ["two"], exit: 1, startedAt: 9000, endedAt: 9000 + 125_000 },
      "2026-09-24T04-00-00-000-fix": { lines: ["three"], startedAt: 20_000, live: true, pid: 999 },
    },
    latest: "2026-09-24T04-00-00-000-fix",
  });
  const rows = listRuns(w.home, w.state.entries(), { isRunning: job => job.pid === 999 });
  assert.deepEqual(rows.map(r => r.run), ["2026-09-24T04-00-00-000-fix", "2026-09-24T03-00-00-000-fix", "2026-09-24T02-00-00-000-start"], "newest first");
  assert.deepEqual(rows.map(r => r.entry), [ID, ID, ID]);
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].exit, null, "a live run has no exit code yet, and 0 would be a lie");
  assert.equal(rows[1].exit, 1);
  assert.equal(rows[1].durationMs, 125_000);
  assert.equal(rows[2].durationMs, 3500);
  assert.equal(rows[0].handle, "widget#142", "the row names the entry the way the rest of the tool does");

  const r = res();
  handle(w.ctx, req("/runs"), r);
  await r.ended;
  assert.equal(r.code, 200);
  const body = r.body();
  assert.match(body, /3 runs, newest first/);
  assert.ok(body.indexOf("04-00-00") < body.indexOf("02-00-00"), "the page is in the same order as the model");
  assert.match(body, /2m 5s/, "a duration is readable, not a millisecond count");

  // A filter that names no entry lists nothing rather than everything, so a stale link cannot widen what it shows.
  const filtered = res();
  handle(w.ctx, req("/runs?entry=acme/widget/gone"), filtered);
  await filtered.ended;
  assert.match(filtered.body(), /No runs on disk yet|0 runs/);

  const mine = res();
  handle(w.ctx, req(`/runs?entry=${encodeURIComponent(ID)}`), mine);
  await mine.ended;
  assert.match(mine.body(), /3 runs/);

  // A run folder whose entry was removed from the registry is skipped: nothing can open it, so a row for it would
  // only be a dead link.
  const orphan = listRuns(w.home, [], { isRunning: () => false });
  assert.deepEqual(orphan, []);
});

test("runs from another tool's flat tree are listed alongside Gallivant's own", async () => {
  // Command center writes job.json and job.log into <project>/.content-pipeline/runs/<id>/, flat rather than keyed
  // by entry, with the same field names. That layout is what lib/run.mjs was adapted from, so the same reader
  // handles both trees and an operator has one runs table rather than two tabs.
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["mine"], exit: 0, startedAt: 5000, endedAt: 6000 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const foreign = join(w.home, "elsewhere", "runs");
  for (const [id, job] of Object.entries({
    "2026-09-25T09-00-00-000-weekly": { name: "weekly", pid: 3, startedAt: 9000, exit: 0, endedAt: 12_000 },
    "2026-09-25T10-00-00-000-plan": { name: "plan 2w", pid: 4, startedAt: 20_000, exit: 1, endedAt: 21_500 },
  })) {
    mkdirSync(join(foreign, id), { recursive: true });
    writeFileSync(join(foreign, id, "job.log"), "hello\n");
    writeFileSync(join(foreign, id, "job.json"), JSON.stringify({ id, ...job }));
  }

  const rows = listFlatRuns(foreign, { source: "aport-vault" });
  assert.deepEqual(rows.map(r => r.run), ["2026-09-25T10-00-00-000-plan", "2026-09-25T09-00-00-000-weekly"], "newest first, as in the other view");
  assert.equal(rows[0].exit, 1);
  assert.equal(rows[0].durationMs, 1500);
  assert.equal(rows[0].source, "aport-vault", "the project stands in for the entry these runs do not have");
  assert.equal(rows[0].entry, null, "and there is no registry entry to address them by");
  assert.equal(rows[0].handle, "plan 2w", "so the job's own name is what the row shows");

  // Merged into the runs view when the host points the tracker at them.
  const ctx = { ...w.ctx, runSources: [{ label: "aport-vault", dir: foreign }] };
  const r = res();
  handle(ctx, req("/runs"), r);
  await r.ended;
  const body = r.body();
  assert.match(body, /3 runs, newest first/, "both trees in one table");
  assert.ok(body.indexOf("plan") < body.indexOf("weekly"), "sorted across sources, not concatenated");
  assert.match(body, /<span class="tag">aport-vault<\/span>/, "a foreign row says where it came from");
  // A foreign run has no entry page, so it opens in this view instead, addressed by its source rather than by a
  // registry id. Every /run link (the entry page) still names a registered entry.
  const opened = [...body.matchAll(/\/run\?[^"]*\bid=([^&"]+)/g)].map(m => decodeURIComponent(m[1]));
  assert.deepEqual([...new Set(opened)], [ID], "the entry page is only ever opened for a registered entry");
  assert.match(body, /\/runs\?[^"]*open=2026-09-25T10-00-00-000-plan[^"]*source=aport-vault/, "a foreign run opens here, by source");

  // Gallivant's own rows are unaffected and still open.
  assert.match(body, /href="\/run\?id=acme%2Fwidget%2Fwidget-export"/);

  // Filtering by entry is Gallivant's own tree only: no foreign run belongs to a registry entry.
  const filtered = res();
  handle(ctx, req(`/runs?entry=${encodeURIComponent(ID)}`), filtered);
  await filtered.ended;
  assert.match(filtered.body(), /1 run, newest first/);
  assert.ok(!filtered.body().includes("aport-vault"));

  // A source directory that does not exist is simply empty, not a crash: these paths are somebody else's to move.
  assert.deepEqual(listFlatRuns(join(w.home, "nope")), []);
});

test("picking a run in the runs sidebar fills the pane beside it, rather than navigating away", async () => {
  // The bug this covers: the sidebar listed runs and clicking one did nothing, because /runs had no detail pane and
  // the rows pointed at the entry page (a different view) or, for a foreign run, at nothing at all.
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["mine"], exit: 0, startedAt: 5000, endedAt: 6000 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const foreign = join(w.home, "elsewhere", "runs");
  mkdirSync(join(foreign, "2026-09-25T10-00-00-000-plan"), { recursive: true });
  writeFileSync(join(foreign, "2026-09-25T10-00-00-000-plan", "job.log"), "planning\n");
  writeFileSync(join(foreign, "2026-09-25T10-00-00-000-plan", "job.json"), JSON.stringify({ id: "2026-09-25T10-00-00-000-plan", name: "plan 2w", pid: 7, startedAt: 9000, exit: 0, endedAt: 9400 }));
  const ctx = { ...w.ctx, runSources: [{ label: "aport-vault", dir: foreign }] };

  // Nothing picked: the table, and no pane.
  const list = res();
  handle(ctx, req("/runs"), list);
  await list.ended;
  assert.ok(!list.body().includes('id="log"'), "no run picked, no pane");
  // Every sidebar row opens a run in this view, including the foreign one that has no entry page.
  const hrefs = [...list.body().matchAll(/<a class="row" href="([^"]+)"/g)].map(m => m[1]);
  assert.equal(hrefs.length, 2);
  assert.ok(hrefs.every(h => h.includes("/runs?") && h.includes("open=")), `every row opens a run here, got ${hrefs.join(" ")}`);

  // Picking Gallivant's own run shows its facts and a pane wired to stream it.
  const mine = res();
  handle(ctx, req("/runs?open=2026-09-24T02-00-00-000-fix"), mine);
  await mine.ended;
  assert.match(mine.body(), /id="log" data-entry="acme\/widget\/widget-export" data-source="" data-run="2026-09-24T02-00-00-000-fix"/);
  assert.equal([...mine.body().matchAll(/aria-current="page"/g)].length, 2, "the nav tab and the picked row are both marked");

  // Picking the foreign one addresses it by source, since it has no entry.
  const theirs = res();
  handle(ctx, req("/runs?open=2026-09-25T10-00-00-000-plan&source=aport-vault"), theirs);
  await theirs.ended;
  assert.match(theirs.body(), /id="log" data-entry="" data-source="aport-vault" data-run="2026-09-25T10-00-00-000-plan"/);
  assert.match(theirs.body(), /plan 2w/, "the pane names the run");

  // And that stream serves it, which is what makes the pane more than decoration.
  const s = sink();
  handle(ctx, req("/api/run/output?source=aport-vault&run=2026-09-25T10-00-00-000-plan", {}), s);
  await s.ended;
  assert.deepEqual(s.lines(), ["planning"]);

  // A source nobody configured reaches no directory, however it is spelled.
  for (const bad of ["../../../etc", "nope", ""]) {
    const r = res();
    handle(ctx, req(`/api/run/output?source=${encodeURIComponent(bad)}&run=2026-09-25T10-00-00-000-plan`), r);
    await r.ended;
    assert.equal(r.code, 404, `source ${JSON.stringify(bad)} is refused`);
  }
  // As does a run id that is not one, inside a source that is.
  const traverse = res();
  handle(ctx, req("/api/run/output?source=aport-vault&run=" + encodeURIComponent("../../../../etc")), traverse);
  await traverse.ended;
  assert.equal(traverse.code, 404);

  // An `open` naming a run that is not on this page selects nothing rather than inventing a pane.
  const ghost = res();
  handle(ctx, req("/runs?open=2026-01-01T00-00-00-000-ghost"), ghost);
  await ghost.ended;
  assert.ok(!ghost.body().includes('id="log"'));
});

test("the stream sends the tail of a finished run and then a terminal frame, so the pane never waits forever", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["line 1", "line 2", "line 3"], exit: 0, endedAt: Date.parse(T0) + 10 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const s = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, {}), s);
  await s.ended;
  assert.equal(s.code, 200);
  assert.equal(s.headers["content-type"], "text/event-stream");
  assert.equal(s.headers["cache-control"], "no-cache");
  assert.equal(s.headers.connection, "keep-alive");
  assert.equal(s.headers["x-accel-buffering"], "no", "a proxy must not buffer the stream");
  assert.deepEqual(s.lines(), ["line 1", "line 2", "line 3"]);
  assert.deepEqual(s.frames.filter(f => f.id).map(f => f.id), ["1", "2", "3"], "every data frame carries its position in the log");
  assert.equal(s.frames.at(-1).value, "[exit 0]", "the stream terminates, or the page says reconnecting forever");
});

test("a long stream is exempt from the request timeout, on the response, the request and the socket", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["x"], exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const s = sink();
  const cleared = [];
  s.setTimeout = ms => cleared.push(["res", ms]);
  const r = req(`/api/run/output?id=${encodeURIComponent(ID)}`, {});
  r.setTimeout = ms => cleared.push(["req", ms]);
  r.socket.setTimeout = ms => cleared.push(["socket", ms]);
  handle(w.ctx, r, s);
  await s.ended;
  assert.deepEqual(cleared, [["res", 0], ["req", 0], ["socket", 0]],
    "all three, or Node's five-minute requestTimeout cuts a half-hour fix round");
});

test("a fresh connection gets a bounded tail and says how many lines it is not showing", async () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`);
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines, exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const s = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, {}), s);
  await s.ended;
  const shown = s.lines();
  assert.equal(shown.length, TAIL, "a fresh connect is bounded");
  assert.equal(shown.at(-1), "line 1200", "the tail ends at the newest line, which is what a reader wants");
  assert.ok(!shown.includes("line 1"), "the oldest output is not replayed");

  const skipped = s.frames.find(f => f.event === "skipped");
  assert.ok(skipped, "a truncated replay announces itself instead of appearing to start mid-log");
  assert.equal(Number(skipped.value), 1200 - TAIL);

  // Ids stay absolute, so a reconnect after a truncated replay resumes in the right place rather than rewinding.
  assert.equal(Number(s.frames.find(f => f.id).id), 1200 - TAIL + 1, "ids are positions in the whole log, not in the tail");
});

test("a reconnecting reader resumes after its last line instead of replaying the log from the top", async () => {
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines, exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });

  const second = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, { "last-event-id": "5" }), second);
  await second.ended;
  assert.deepEqual(second.lines(), ["line 6", "line 7", "line 8"], "a resumed stream does not repeat what was shown");
  assert.deepEqual(second.frames.filter(f => f.id).map(f => f.id), ["6", "7", "8"], "ids continue from where the reader was");
  assert.ok(!second.frames.some(f => f.event === "skipped"), "a resume is not a truncation and must not claim one");

  // A garbled id is ignored rather than skipping the log, since a browser can send anything.
  for (const bad of ["not-a-number", "-5", "", "1.5"]) {
    const s = sink();
    handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, { "last-event-id": bad }), s);
    await s.ended;
    assert.deepEqual(s.lines(), lines, `last-event-id ${JSON.stringify(bad)} must replay from the top`);
  }
});

test("a run with no log yet, and an entry that never ran, each say so rather than hanging", async () => {
  const empty = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: [], exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const s = sink();
  handle(empty.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, {}), s);
  await s.ended;
  assert.deepEqual(s.frames.map(f => f.value), ["[exit 0]"]);

  const never = world();
  const page = res();
  handle(never.ctx, req(`/run?id=${encodeURIComponent(ID)}`), page);
  await page.ended;
  assert.equal(page.code, 200);
  assert.match(page.body(), /No run has been dispatched/);

  const stream = res();
  handle(never.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`), stream);
  await stream.ended;
  assert.equal(stream.code, 404, "there is no run to stream, and a 404 says that once instead of an empty stream");

  // streamRun itself, on a directory holding no job.json: the frame a reader gets is a terminal one either way.
  const bare = sink();
  streamRun(bare, join(never.home, "runs", "nothing"), { isRunning: () => false, req: req("/") });
  await bare.ended;
  assert.deepEqual(bare.frames.map(f => f.value), ["[no run]"]);
});

test("a live run keeps the stream open and delivers lines appended after the reader attached", async () => {
  const runId = "2026-09-24T02-00-00-000-fix";
  const w = world({ runs: { [runId]: { lines: ["first"], live: true, pid: 4242 } }, latest: runId });
  const log = join(w.root, runId, "job.log");
  const jobFile = join(w.root, runId, "job.json");
  let live = true;
  const s = sink();
  // The poll floor is turned right down so the test does not wait a second per line; fs.watch does the rest.
  streamRun(s, join(w.root, runId), { isRunning: () => live, req: req("/"), pollMs: 20, beatMs: 10_000 });
  assert.deepEqual(s.lines(), ["first"], "what was already on disk arrives at once");

  writeFileSync(log, "first\nsecond\n");
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(s.lines(), ["first", "second"], "a line appended after the connect is followed from the file, not from a pipe");

  // The harness exits and the tick records it. Liveness comes from the OS, so the stream ends on its own.
  writeFileSync(jobFile, JSON.stringify({ id: runId, pid: 4242, bin: "/bin/claude", startedAt: 1, exit: 0, endedAt: 2 }));
  live = false;
  await s.ended;
  assert.equal(s.frames.at(-1).value, "[exit 0]");
});

test("a run whose process is gone but whose exit was never recorded says so, and never invents a verdict", async () => {
  // Exactly what a daemon killed mid-run leaves behind: exit null in job.json and no process. The tick is the only
  // thing allowed to write the outcome, so the viewer must end the stream without deciding what the exit was.
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["working on it"], exit: null, pid: 999_999 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const s = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, {}), s);
  await s.ended;
  assert.deepEqual(s.lines(), ["working on it"]);
  assert.match(s.frames.at(-1).value, /^\[ended, waiting for the next tick/, "the stream terminates, and says why it has no exit code");
  assert.ok(!/\[exit (0|1)\]/.test(s.frames.at(-1).value), "an unrecorded exit is never reported as a success or a failure");
  // And nothing was written back: the run folder is exactly as the tick will find it.
  assert.equal(JSON.parse(readFileSync(join(w.root, "2026-09-24T02-00-00-000-fix", "job.json"), "utf8")).exit, null,
    "the viewer is read-only, so job.json is untouched");
  // The page's script must recognise that frame as terminal, or the pane reconnects forever.
  const js = res();
  handle(w.ctx, req("/tracker.js"), js);
  await js.ended;
  assert.match(js.body(), /exit\|no run\|ended/);
});

test("mounted under a prefix, every URL the pages emit carries it, and standalone keeps absolute paths", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["x"], exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const tracker = mount(w.ctx, { base: "/gallivant" });
  assert.equal(tracker.base, "/gallivant");

  const get = async path => { const r = res(); tracker.handle(req(path), r); await r.ended; return r; };

  // The prefix itself is the dashboard, not a 404: a host that delegates /gallivant means /gallivant to be the root.
  const dash = await get("/gallivant");
  assert.equal(dash.code, 200);
  const links = [...new Set([...dash.body().matchAll(/(?:href|src)="(\/[^"]*)"/g)].map(m => m[1]))];
  assert.ok(links.length > 3, "the page emits internal links");
  assert.ok(links.every(l => l.startsWith("/gallivant/")), `every internal link sits under the mount, got ${links.join(" ")}`);
  // The script is one static file, so it learns where it lives from the DOM rather than at build time.
  assert.match(dash.body(), /<body data-base="\/gallivant">/);

  for (const path of ["/gallivant/", "/gallivant/runs", "/gallivant/tracker.css", "/gallivant/tracker.js", `/gallivant/run?id=${encodeURIComponent(ID)}`, "/gallivant/api/status"])
    assert.equal((await get(path)).code, 200, `${path} is served under the mount`);

  // A 404 under the mount is the tracker's own, and its way back points at the mount rather than at the host's root.
  const miss = await get("/gallivant/nope");
  assert.equal(miss.code, 404);
  assert.match(miss.body(), /href="\/gallivant\/"/);
  // The legacy redirect lands inside the mount too, or it would leave the tracker entirely.
  const old = await get("/gallivant/api/run/log?id=x");
  assert.equal(old.code, 302);
  assert.equal(old.headers.location, "/gallivant/api/run/output?id=x");
  // And the id checks are unchanged by the prefix.
  assert.equal((await get("/gallivant/run?id=" + encodeURIComponent("../../etc/passwd"))).code, 404);

  // owns() is what a host asks before handing a request over: the prefix and everything under it, nothing else.
  assert.ok(tracker.owns(req("/gallivant")));
  assert.ok(tracker.owns(req("/gallivant/runs")));
  assert.ok(!tracker.owns(req("/")), "the host keeps its own root");
  assert.ok(!tracker.owns(req("/api/tree")), "and its own api");
  assert.ok(!tracker.owns(req("/gallivanting")), "a path that merely starts with the same letters is not ours");

  // Standalone is untouched: no prefix, absolute links, which is what `gallivant serve` serves.
  const solo = res();
  handle(w.ctx, req("/"), solo);
  await solo.ended;
  assert.match(solo.body(), /<body data-base="">/);
  assert.ok([...solo.body().matchAll(/(?:href|src)="(\/[^"]*)"/g)].every(m => !m[1].startsWith("/gallivant")), "no mount path leaks into the standalone pages");

  // A base is normalised rather than trusted, and an empty one is refused: mounting at the root is what serve() does.
  assert.equal(mount(w.ctx, { base: "gallivant/" }).base, "/gallivant");
  assert.equal(mount(w.ctx, { base: "//gallivant//" }).base, "/gallivant");
  assert.throws(() => mount(w.ctx, { base: "/" }), /non-empty base/);
  assert.throws(() => mount(w.ctx, { base: "" }), /non-empty base/);
});

test("/api/run/log still resolves, because the old path is in bookmarks", async () => {
  const w = world();
  const r = res();
  handle(w.ctx, req("/api/run/log?id=x&run=y"), r);
  await r.ended;
  assert.equal(r.code, 302);
  assert.equal(r.headers.location, "/api/run/output?id=x&run=y");
});

test("/api/run/status reports one run for a caller that wants a line, not a stream", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["a", "b", "done"], exit: 1, endedAt: 5 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const r = res();
  handle(w.ctx, req(`/api/run/status?id=${encodeURIComponent(ID)}`), r);
  await r.ended;
  assert.deepEqual(JSON.parse(r.body()), { entry: ID, run: "2026-09-24T02-00-00-000-fix", running: false, exit: 1, lines: 3, last: "done" });

  const unknown = res();
  handle(w.ctx, req("/api/run/status?id=nope"), unknown);
  await unknown.ended;
  assert.equal(unknown.code, 404);
});

test("a handler that throws gives the reader a status, never the exception text", async () => {
  const w = world();
  const broken = { ...w.ctx, state: { entries: () => { throw new Error("/Users/someone/.gallivant/secret.json is unreadable"); }, get: () => null } };
  const r = res();
  handle(broken, req("/runs"), r);
  await r.ended;
  assert.equal(r.code, 500);
  assert.ok(!r.body().includes("secret.json"), "a path in an exception message must not reach the browser");
});

// ---- stream-json log lines ------------------------------------------------------
// A Gallivant run writes the harness's own stream-json to job.log, so a line in the pane is an event object, not
// prose. The renderer is still command-center's: what changed is a reader in front of it (lib/harness_log.mjs) that
// turns one event into the { kind, tool, arg } that renderer already took.
//
// The fixtures below are lines from a real run under ~/.gallivant/runs, trimmed to the fields that matter, so the
// field names are Claude Code's own rather than ones invented here. That run is where `non_execution_kind` and the
// APort denial text came from; guessing either would have produced a test that passes and a pane that does not.

/** A tool call, exactly as the run wrote it (ids and the caller field dropped). */
const TOOL_USE = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: 'ls && echo "---" && ls docs/prds/', description: "List repo root" } }] },
});
/** Prose from the model, in its own event. */
const TEXT_BLOCK = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "I'll start by exploring the repo structure and the PRD context." }] },
});
/**
 * A denial. This is the shape a blocked call actually arrives in, and it is not a hook event: the APort PreToolUse
 * hook denies, Claude turns the denial into the tool's RESULT, and `tool_result_meta.non_execution_kind` records
 * that the tool never ran. Taken verbatim from the run that had two Bash calls blocked.
 */
const DENIAL = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: "toolu_01WruLZdGgthtWpfHbFArYcX",
    content: "APort denied this tool call. Policy: bash. Reason: oap.blocked_pattern. Detail: Command contains dangerous pattern: Access to sensitive configuration files." }] },
  tool_result_meta: [{ id: "toolu_01WruLZdGgthtWpfHbFArYcX", non_execution_kind: "permission-rule" }],
});
/** A tool result that succeeded: recognised, and worth no row. */
const RESULT_OK = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01CoBRACt1Jxb4sxig7MXkrT", content: "_plan\nagent-jail\nAGENTS.md" }] },
});

/**
 * The renderer out of the served script, which is the only copy a browser ever runs.
 *
 * The script's own two jobs need a document; the renderer does not. So it is evaluated from the top of the spliced
 * reader (the served file's first statement after "use strict") down, which is every function under test and none of
 * the DOM wiring. The existing renderer test slices from the escaper for the same reason.
 */
async function served(w) {
  const r = res();
  handle(w.ctx, req("/tracker.js"), r);
  await r.ended;
  const src = r.body();
  const from = src.indexOf("const ARG_KEYS");
  assert.ok(from > 0, "the served script carries the spliced reader");
  const body = src.slice(from, src.indexOf("// Where this tracker is mounted")) + src.slice(src.indexOf("// ---- log lines"));
  return new Function(body + "; return { renderLine, parseLine, harnessLine };")();
}

test("a stream-json tool call renders as the tool column plus one argument, toned like command-center's", async () => {
  const { renderLine } = await served(world());

  const bash = renderLine(TOOL_USE, { harness: "claude" });
  assert.match(bash, /^<div class="ll t shell">/, "Bash is the shell tone, the same class command-center gives it");
  assert.match(bash, /<span class="n">Bash<\/span>/, "the tool name is the label in the 96px column");
  assert.match(bash, /<span class="a">ls &amp;&amp; echo/, "the argument is `command`, escaped");
  assert.ok(!bash.includes("description"), "one argument, not the whole input object");

  // Each of the six keys the harness actually puts in a tool input, in the order they are preferred.
  const arg = (name, input) => renderLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }), { harness: "claude" });
  assert.match(arg("Read", { file_path: "/tmp/wt/docs/prds/one.md" }), /class="ll t write"|class="ll t read"/);
  assert.match(arg("Read", { file_path: "/tmp/wt/docs/prds/one.md" }), /<span class="a">\/tmp\/wt\/docs\/prds\/one\.md<\/span>/);
  assert.match(arg("Grep", { pattern: "getCanonicalSiteRedirectUrl" }), /<span class="a">getCanonicalSiteRedirectUrl<\/span>/);
  assert.match(arg("WebFetch", { url: "https://aport.io/docs" }), /class="ll t fetch"/);
  assert.match(arg("Task", { description: "Install workspace deps", prompt: "do the thing" }), /class="ll t agent"/);
  assert.match(arg("Task", { description: "Install workspace deps", prompt: "do the thing" }), /<span class="a">Install workspace deps<\/span>/, "description wins over prompt");
  assert.match(arg("Agent", { prompt: "review the diff" }), /<span class="a">review the diff<\/span>/, "prompt is the last resort, not nothing");
  // A heredoc in a Bash command is forty lines; a row is one line tall.
  assert.match(arg("Bash", { command: "cat <<EOF\none\ntwo\nEOF" }), /<span class="a">cat &lt;&lt;EOF one two EOF<\/span>/);

  // One event can carry prose and several parallel calls. Every one gets a row, in the order the model wrote them.
  const batch = renderLine(JSON.stringify({ type: "assistant", message: { content: [
    { type: "text", text: "Reading both files." },
    { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
    { type: "tool_use", name: "Read", input: { file_path: "b.ts" } },
  ] } }), { harness: "claude" });
  assert.equal([...batch.matchAll(/<div class="ll/g)].length, 3, "three blocks, three rows");
  assert.ok(batch.indexOf("Reading both files") < batch.indexOf("a.ts"), "the prose that introduces a batch reads above it");
});

test("a text block renders as prose, not as a tool row", async () => {
  const { renderLine } = await served(world());
  const html = renderLine(TEXT_BLOCK, { harness: "claude" });
  // No `t` and no `d`, which is exactly what `.ll:not(.t):not(.d):not(.skip)` styles as the readable prose colour.
  assert.equal(html, `<div class="ll">I&#39;ll start by exploring the repo structure and the PRD context.</div>`.replace("&#39;", "'"));
  assert.ok(!html.includes('class="ll t'), "prose is not a tool call");
});

test("a blocked tool call is the loudest row in the pane, not another line of noise", async () => {
  const { renderLine } = await served(world());
  const html = renderLine(DENIAL, { harness: "claude" });
  // The closing line's weight and border, in the failure colour: the same class the run that failed gets, because a
  // guardrail refusal is the same class of news. A `meta` tool row would read as bookkeeping and be scrolled past.
  assert.match(html, /^<div class="ll d bad">/, "a denial carries the closing line's weight and the failure colour");
  assert.match(html, /<span class="n">BLOCKED<\/span>/, "and says so in one word");
  assert.match(html, /oap\.blocked_pattern/, "with the policy reason the hook gave, so the operator knows what to change");
  // What it must NOT look like: an ordinary tool call, or a tool that merely errored.
  assert.ok(!/class="ll t/.test(html), "a denial is not a tool row");

  // A hook that denies before the call, rather than through the result, is the same row. APort's hook writes
  // Claude's official schema, and its own header documents exit 2 as the second blocking path.
  const hook = JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "PreToolUse:Bash", exit_code: 0,
    output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "APort: write outside the worktree" } }) });
  assert.match(renderLine(hook, { harness: "claude" }), /^<div class="ll d bad"><span class="n">BLOCKED<\/span> APort: write outside the worktree<\/div>$/);

  const byExit = JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "PreToolUse:Bash", exit_code: 2, stderr: "APort: jq is required" });
  assert.match(renderLine(byExit, { harness: "claude" }), /class="ll d bad".*BLOCKED.*jq is required/);

  // A hook that allowed the call is bookkeeping and reads as such.
  const ok = JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", outcome: "success", output: "", exit_code: 0 });
  assert.match(renderLine(ok, { harness: "claude" }), /^<div class="ll t meta">/);
});

test("the result event closes the pane with the cost and the verdict", async () => {
  const { renderLine } = await served(world());

  const ok = renderLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Pushed the fix.", total_cost_usd: 1.4832 }), { harness: "claude" });
  // The model's report reads as prose, and the closing line under it is short: the verdict and the cost.
  assert.match(ok, /<div class="ll">Pushed the fix\.<\/div>/, "the run's own answer is prose, not part of the closing line");
  assert.match(ok, /<div class="ll d ok">done \$1\.4832<\/div>$/, "the closing line, in the success colour, with the cost on it");

  // Why the closing line does not carry the report. This is the real `result` event from the run under
  // ~/.gallivant/runs that ended on budget: `result` holds a twelve-paragraph markdown report, `errors` holds the
  // one-line reason. Putting `result` on the closing line made a single unreadable row a screen wide, which is the
  // bug this whole rendering exists to stop.
  const budget = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 5.026058999999999,
    errors: ["Reached maximum budget ($5)"], terminal_reason: "budget_exhausted",
    result: "## Status: incomplete\n\nI spent the $5 budget and stopped before opening the PR.\n\n- ac-1 passes\n- ac-2 passes\n\nFull suite: 55 tests pass." });
  const rows = renderLine(budget, { harness: "claude" }).match(/<div class="ll[^"]*">.*?<\/div>(?:<\/div>)?/g);
  assert.deepEqual(rows, [
    // A markdown heading IS the row, so the hashes go and the text carries the weight instead.
    `<div class="ll"><b>Status: incomplete</b></div>`,
    `<div class="ll">I spent the $5 budget and stopped before opening the PR.</div>`,
    // The two bullets are ONE list, as a real <ul>, rather than two rows each starting with a literal dash. That was
    // the reader's complaint: the markdown was on screen as the characters the model typed rather than as a list.
    `<div class="ll blk"><ul class="md"><li>ac-1 passes</li><li>ac-2 passes</li></ul></div>`,
    `<div class="ll">Full suite: 55 tests pass.</div>`,
    `<div class="ll d bad">failed $5.0261 Reached maximum budget ($5)</div>`,
  ], "the report keeps the blocks the model wrote, and the closing line stays one line");

  const bad = renderLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.91 }), { harness: "claude" });
  assert.match(bad, /^<div class="ll d bad">failed \$0\.9100 error_max_turns<\/div>$/, "the verdict, the cost and why, in that order");

  // The same flattening bug in ordinary prose: a long assistant message is markdown and was arriving as one row.
  const long = JSON.stringify({ type: "assistant", message: { content: [{ type: "text",
    text: "### What is done\n\nThe redirect is 301 now, and the\nwrapped sentence still joins.\n\n1. ac-3 passes\n2. ac-4 passes" }] } });
  assert.deepEqual(renderLine(long, { harness: "claude" }).match(/<div class="ll[^"]*">.*?<\/div>(?:<\/div>)?/g), [
    `<div class="ll"><b>What is done</b></div>`,
    `<div class="ll">The redirect is 301 now, and the wrapped sentence still joins.</div>`,
    // A numbered list is an <ol>, and the browser writes the numbers: the model's own "1." and "2." are the marker,
    // not text, so they are not on the page twice.
    `<div class="ll blk"><ol class="md"><li>ac-3 passes</li><li>ac-4 passes</li></ol></div>`,
  ], "a heading is a row, a numbered list is one list, and a wrapped sentence still joins");

  // A tool result that errored without being blocked is a tool row in the failure tone, not the closing line: the
  // run is still going and a closing line would say otherwise.
  const err = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "npm ERR! missing script: bild" }] } });
  assert.match(renderLine(err, { harness: "claude" }), /^<div class="ll t bad"><span class="n">ERROR<\/span><span class="a">npm ERR! missing script: bild<\/span><\/div>$/);

  // A tool result that succeeded is recognised and carries no row: it is the output the run read, not what it did.
  assert.equal(renderLine(RESULT_OK, { harness: "claude" }), "", "a clean tool result is dropped, deliberately");
});

test("a line the reader cannot place renders as itself, escaped, and never as nothing", async () => {
  const { renderLine } = await served(world());
  for (const line of [
    "harness claude, prompt 4120 chars",                          // the runner's own opening line
    "done in 42s (harness exit 0)",                               // and its closing one
    "{not json at all",                                           // a truncated write, which a killed run leaves
    '{"type":"invented_event","detail":"nothing reads this"}',     // an event no reader claims
    "npm ERR! code ELIFECYCLE",                                   // a harness spilling to stderr
    "[]",                                                         // JSON, but not an event object
  ]) {
    const html = renderLine(line, { harness: "claude" });
    assert.notEqual(html, "", `${JSON.stringify(line)} must not vanish: an unreadable line is still evidence`);
    assert.match(html, /^<div class="ll/, `${JSON.stringify(line)} is still a row`);
  }
  // The prose rules command-center wrote still apply to those lines, so the runner's own output reads as it did.
  assert.match(renderLine("harness claude v2.1.263, prompt 4120 chars", { harness: "claude" }), /class="ll h"/);
  assert.match(renderLine("done in 42s (harness exit 0)", { harness: "claude" }), /class="ll d ok"/);
  assert.match(renderLine("failed after 271s: boom", { harness: "claude" }), /class="ll d bad"/);
  // With no harness named, every line goes through the prose rules alone, which is what a foreign run gets. A line
  // nothing claimed is a `raw` row: the same text, escaped, with the markdown pass off. See the next test for why.
  assert.equal(renderLine(TOOL_USE), `<div class="ll raw">${esc(TOOL_USE)}</div>`.replaceAll("&#39;", "'"));
});

test("a line nobody claimed keeps every character it had, because the markdown pass would eat some of them", async () => {
  const { renderLine, parseLine } = await served(world());

  // The real line, from ~/.gallivant/runs/.../2026-09-27T03-01-02-331-start/job.log. A variadic `--add-dir` swallowed
  // the prompt, the harness printed this on stderr, and it is the only line in that run that says why it failed.
  const real = "Error: Input must be provided either through stdin or as a prompt argument when using --print";
  assert.deepEqual(parseLine(real, { harness: "claude" }), { kind: "raw", text: real });
  assert.equal(renderLine(real, { harness: "claude" }), `<div class="ll raw">${real}</div>`);

  // Why `raw` and not `text`. A prose row runs the markdown pass, which is right for a paragraph the model wrote and
  // wrong for a message nobody wrote as markdown: `*` and `_` pairs were read as emphasis and the characters between
  // them were DELETED from the page. That is the "renders as nothing" the reader saw, for the characters that mattered.
  for (const [line, gone] of [
    ["Error: --add-dir *cannot* be used with __proto__", ["*cannot*", "__proto__"]],
    ["npm ERR! cannot resolve **/*.test.mjs under _build_", ["**/*.test.mjs", "_build_"]],
    ["# this is a shell comment, not a heading", ["#"]],
  ]) {
    const html = renderLine(line, { harness: "claude" });
    assert.ok(!/<[bi]>/.test(html), `${JSON.stringify(line)} must not be read as markdown`);
    for (const piece of gone) assert.ok(html.includes(esc(piece)), `${JSON.stringify(line)} lost ${piece}`);
  }

  // And the escape still holds on the new path, because this is the least trustworthy row on the page: it is whatever
  // the harness printed, which includes whatever it was reading at the time.
  for (const payload of [
    `<script>alert(1)</script>`,
    `Error: <img src=x onerror="alert(1)"> while reading __proto__`,
    `Error: see http://evil.example/"onmouseover="alert(1)`,
    `Error: javascript:alert(1)`,
  ]) {
    const html = renderLine(payload, { harness: "claude" });
    assert.match(html, /^<div class="ll raw">/, "still a row, whatever it contains");
    for (const [, name, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
      assert.ok(["div", "span", "a"].includes(name), `${payload} produced a <${name}>`);
      const keys = [...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(m => m[1]);
      assert.ok(!keys.some(k => /^on/i.test(k)), `${payload} produced an event handler: ${attrs}`);
      const href = /href="([^"]*)"/.exec(attrs);
      assert.ok(!href || /^https?:/.test(href[1]), `${payload} produced a non-http href`);
    }
    assert.ok(!/<script|<img/i.test(html), `${payload} produced a tag it asked for`);
    assert.ok(!/javascript:/i.test(html.replace(/>[^<]*</g, "><")), `${payload} put a javascript: URL in an attribute`);
  }
});

test("a hostile tool_use cannot put a tag or a handler on the page", async () => {
  const { renderLine } = await served(world());
  // Log content is the least trustworthy input the product has: it is written by an agent, and much of it is
  // quoted out of files the agent read. So the payloads go through the new path as well as the old one.
  const hostile = [
    // A tool name and an argument that are both markup.
    { type: "assistant", message: { content: [{ type: "tool_use", name: "<script>alert(1)</script>", input: { command: "<img src=x onerror=alert(1)>" } }] } },
    // A javascript: URL where the renderer would otherwise build a link.
    { type: "assistant", message: { content: [{ type: "tool_use", name: "WebFetch", input: { url: "javascript:alert(document.cookie)" } }] } },
    // The same thing hidden behind an http URL that closes the attribute it is inside.
    { type: "assistant", message: { content: [{ type: "tool_use", name: "WebFetch", input: { url: `http://evil.example/"onmouseover="alert(1)` } }] } },
    // Prose the model wrote.
    { type: "assistant", message: { content: [{ type: "text", text: `<img src=x onerror="alert(2)"> and <iframe src=//evil>` }] } },
    // A denial whose reason quotes the command that was blocked, which is the most likely place for this.
    { type: "user", tool_result_meta: [{ non_execution_kind: "permission-rule" }],
      message: { role: "user", content: [{ type: "tool_result", is_error: true, content: `APort denied: <script>alert(1)</script> javascript:alert(2)` }] } },
    // The closing line, whose text comes from the model's own last message.
    { type: "result", is_error: true, result: `<svg onload=alert(1)>`, total_cost_usd: 0.1 },
    // A hook reason, which is a string the hook printed and the hook is a shell script.
    { type: "system", subtype: "hook_response", exit_code: 2, stderr: `<object data=x onerror=alert(1)>` },
  ];
  for (const ev of hostile) {
    const line = JSON.stringify(ev);
    const html = renderLine(line, { harness: "claude" });
    // The property is not "the bytes are absent" but "no tag came from the payload". Read every tag the browser
    // would build and check it against the three this renderer writes.
    for (const [, name, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
      assert.ok(["div", "span", "a"].includes(name), `${line} produced a <${name}>`);
      const keys = [...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(m => m[1]);
      assert.ok(!keys.some(k => /^on/i.test(k)), `${line} produced an event handler: ${attrs}`);
      const href = /href="([^"]*)"/.exec(attrs);
      assert.ok(!href || /^https?:/.test(href[1]), `${line} produced a non-http href: ${href?.[1]}`);
    }
    assert.ok(!/<script|<img|<iframe|<svg|<object/i.test(html), `${line} produced a tag it asked for`);
    assert.ok(!/javascript:/i.test(html.replace(/>[^<]*</g, "><")), `${line} put a javascript: URL in an attribute`);
  }
});

test("codex's stream reads the same way, from its own event names", async () => {
  // Captured from a real `codex exec --json` run against codex-cli 0.157.0 on 2026-09-27, trimmed. The capture is
  // what stopped two guesses reaching the pane: a tool call fires as `item.started` AND `item.completed`, so reading
  // both would double every row, and `turn.completed.usage` holds token counts with no cost in it at all.
  const { renderLine } = await served(world());
  const rows = [
    '{"type":"thread.started","thread_id":"01a0e0e8-41f2-7f21-b2fb-1e516887dec3"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will run `echo hello`, then stop."}}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -c \'echo hello\'","exit_code":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -c \'echo hello\'","aggregated_output":"hello\\n","exit_code":0,"status":"completed"}}',
    '{"type":"turn.completed","usage":{"input_tokens":32685,"output_tokens":128}}',
  ].map(l => renderLine(l, { harness: "codex" }));

  assert.match(rows[0], /class="ll h"/, "the thread id opens the pane, as claude's session id does");
  assert.equal(rows[1], "", "turn.started is bookkeeping");
  assert.match(rows[2], /^<div class="ll">I will run/, "prose is prose here too");
  assert.match(rows[3], /^<div class="ll t shell"><span class="n">Bash<\/span>/, "the running call is the row, with the shell tone claude's Bash gets");
  assert.equal(rows[4], "", "its completed twin is not a second row");
  assert.match(rows[5], /^<div class="ll d ok">done<\/div>$/, "no cost on the closing line, because codex reports none");
});

test("the reader the browser runs is the one the server imports, not a second copy", async () => {
  // The per-harness reader lives in lib/harness_log.mjs, beside the adapters, because knowing a harness's stream
  // shape is what lib/harness.mjs already does. The browser gets it by splice, not by a copy in templates/: the
  // five log panels command-center replaced were five copies of one parse, and this is the same trap one file over.
  const { harnessLine: spliced } = await served(world());
  const { harnessLine: imported, readers } = await import("../lib/harness_log.mjs");
  for (const line of [TOOL_USE, TEXT_BLOCK, DENIAL, RESULT_OK, '{"type":"result","is_error":false,"total_cost_usd":1}', "not json"]) {
    assert.deepEqual(spliced("claude", line), imported("claude", line), `the two copies disagree on ${line.slice(0, 60)}`);
  }
  // Every harness the loop can run has a reader, so a run is never rendered by the reader of a different harness.
  const { adapters } = await import("../lib/harness.mjs");
  assert.deepEqual(Object.keys(readers).sort(), Object.keys(adapters).sort(), "a harness with no reader would silently fall through to raw lines");
  // A name that is not a harness reads nothing, which is the raw-line path, not a crash.
  assert.equal(imported("nonesuch", TOOL_USE), null);
  assert.equal(imported("claude", ""), null, "an empty line is not an event");
});

test("the log pane is told which harness wrote the log, since the line shape is the harness's", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: [TOOL_USE], exit: 0, endedAt: Date.parse(T0) + 10 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const r = res();
  handle(w.ctx, req(`/run?id=${encodeURIComponent(ID)}`), r);
  await r.ended;
  assert.match(r.body(), /id="log"[^>]*data-harness="claude"/, "the entry's harness reaches the script through the DOM");

  // The stream is unchanged by any of this: the frame still carries the line the harness wrote, byte for byte, and
  // the rendering happens in the browser. A structured frame would have broken Last-Event-ID resume.
  const s = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`), s);
  await s.ended;
  assert.deepEqual(s.lines(), [TOOL_USE], "the SSE frame is still the raw line");
});

test("a reconnect does not draw the closing line twice", async () => {
  // The server re-sends the terminal frame to any reader that resumes after the run is over: `streamRun` reads
  // job.json, sees the process is gone, and ends the stream. That is correct for the server, and it means the pane
  // can see the frame more than once on a long run that reconnected. It printed the line each time.
  const lines = ["a", "b"];
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines, exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const first = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`), first);
  await first.ended;
  const second = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, { "last-event-id": "2" }), second);
  await second.ended;
  const terminal = f => !f.event && /^\[/.test(String(f.value));
  assert.ok(first.frames.some(terminal) && second.frames.some(terminal), "both connections are told the run ended");

  // So the guard has to be on the page. The script records that the end was drawn before drawing anything, and the
  // check comes first, which is what makes a second frame a no-op rather than a second row.
  const r = res();
  handle(w.ctx, req("/tracker.js"), r);
  await r.ended;
  const terminalBlock = /if \(\/\^\\\[\(exit\|no run\|ended\)\\b\/\.test\(text\)\) \{([\s\S]*?)\n    \}/.exec(r.body());
  assert.ok(terminalBlock, "the script still has one place where a terminal frame is handled");
  assert.ok(terminalBlock[1].indexOf("if (closed) return;") < terminalBlock[1].indexOf("note("),
    "the already-closed check must come before the line is drawn, or the second frame draws a second row");
});

test("markdown in a model's prose is rendered, and only the subset a log line actually contains", async () => {
  const { renderLine } = await served(world());
  const prose = text => renderLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }), { harness: "claude" });

  assert.equal(prose("**ac-1** passes"), `<div class="ll"><b>ac-1</b> passes</div>`);
  assert.equal(prose("the *real* bug"), `<div class="ll">the <i>real</i> bug</div>`);
  assert.equal(prose("run `npm test` first"), `<div class="ll">run <code>npm test</code> first</div>`);
  assert.equal(prose("### What is done"), `<div class="ll"><b>What is done</b></div>`, "a heading is the row, so the hashes go");
  // A blockquote is a block, so the marker goes and the row says it was a quote. The marker used to be stripped per
  // line and nothing on the page then said the lines had been quoted at all.
  assert.equal(prose("> quoted"), `<div class="ll blk"><blockquote><p>quoted</p></blockquote></div>`);
  assert.equal(prose("[the PR](https://github.com/acme/widget/pull/142)"),
    `<div class="ll"><a href="https://github.com/acme/widget/pull/142" target="_blank" rel="noopener noreferrer">the PR</a></div>`);

  // Inline code is taken out before emphasis, so a `*` or `_` inside a code span stays a character. This is the bug
  // every naive markdown regex has, and a shell command in backticks is exactly where it would show up.
  assert.equal(prose("run `ls *.ts` and `a_b_c`"), `<div class="ll">run <code>ls *.ts</code> and <code>a_b_c</code></div>`);
  // A snake_case identifier in prose is a name, not emphasis.
  assert.equal(prose("the tool_result_meta field"), `<div class="ll">the tool_result_meta field</div>`);
  // A bare bullet is a list item now, and the `*` is the marker rather than the start of an italic run. Both halves
  // matter: the block pass must claim it, and whatever text is left must not then be read as emphasis.
  assert.equal(prose("* one"), `<div class="ll blk"><ul class="md"><li>one</li></ul></div>`);
  // The same `*` in the MIDDLE of a line is still not emphasis, which is the property the bullet case used to carry.
  assert.equal(prose("count 2 * 3 items"), `<div class="ll">count 2 * 3 items</div>`);
  // Bold wins over italic, so ** is not read as two * runs.
  assert.equal(prose("**bold** not *italic*"), `<div class="ll"><b>bold</b> not <i>italic</i></div>`);

  // A tool argument is NOT markdown: a `*` there is a glob and an `_` is part of a filename. Reading either as
  // emphasis would corrupt the one thing that row exists to show.
  const glob = renderLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls *.ts && cat a_b_c.md" } }] } }), { harness: "claude" });
  assert.match(glob, /<span class="a">ls \*\.ts &amp;&amp; cat a_b_c\.md<\/span>/, "a glob stays a glob and a filename stays a filename");
  assert.ok(!/<i>|<b>|<code>/.test(glob), "no markdown is read in a tool argument");
});

test("markdown cannot be used to inject markup, because it runs on escaped text", async () => {
  const { renderLine } = await served(world());
  const prose = text => renderLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }), { harness: "claude" });

  for (const payload of [
    "**<script>alert(1)</script>**",                              // markup inside emphasis
    "`<img src=x onerror=alert(1)>`",                             // and inside a code span
    "[click](javascript:alert(document.cookie))",                  // a link markdown asked to build
    "[click](data:text/html,<script>alert(1)</script>)",           // and the other scheme that runs
    `[click](https://ok.example/" onmouseover="alert(1))`,         // an http href that closes its own attribute
    "**bold** <b onmouseover=alert(1)>theirs</b>",                 // a tag of their own next to one of ours
    "# <iframe src=//evil>",                                       // markup where a heading's text goes
  ]) {
    const html = prose(payload);
    for (const [, name, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
      // Markdown adds three tags to the three the renderer already wrote. Nothing else may appear.
      assert.ok(["div", "span", "a", "b", "i", "code"].includes(name), `${payload} produced a <${name}>`);
      const keys = [...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(m => m[1]);
      assert.ok(!keys.some(k => /^on/i.test(k)), `${payload} produced an event handler: ${attrs}`);
      const href = /href="([^"]*)"/.exec(attrs);
      assert.ok(!href || /^https?:\/\//.test(href[1]), `${payload} produced a non-http href: ${href?.[1]}`);
    }
    assert.ok(!/<script|<img|<iframe|<svg|<object/i.test(html), `${payload} produced a tag it asked for`);
  }
  // A link markdown refused to build stays the characters the model typed, rather than vanishing.
  assert.match(prose("[click](javascript:alert(1))"), /\[click\]\(javascript:alert\(1\)\)/);

  // Markup one pass finished with must not be edited by the next. The bare-URL pass runs after markdown, and without
  // parking it found the href markdown had just written and linkified the URL inside the attribute, nesting an
  // anchor inside another anchor's href. One <a> per link, and the href is a URL rather than markup.
  const link = prose("see [the PR](https://github.com/acme/widget/pull/142) now");
  assert.equal([...link.matchAll(/<a /g)].length, 1, "one anchor, not an anchor inside an href");
  assert.match(link, /href="https:\/\/github\.com\/acme\/widget\/pull\/142"/, "the href is the URL, not markup");
  // The same trap for a code span: a URL inside backticks is code, and stays the characters it was.
  assert.equal(prose("run `curl https://example.com/x`"), `<div class="ll">run <code>curl https://example.com/x</code></div>`);
});

// ---- the block level of a model's markdown --------------------------------------

/**
 * The final summary of the run under ~/.gallivant/runs that ended with the push blocked, trimmed to the blocks that
 * matter and otherwise verbatim. This is the report the reader was looking at when they said the pane was not
 * formatting markdown: a heading, two fenced blocks, a pipe table, bold and inline code.
 */
const SUMMARY = [
  "## Work complete and committed locally; push and PR are blocked on credentials",
  "",
  "All nine criteria are implemented, but **I could not push or open the PR**. Both auth routes need files the",
  "sandbox denies: `~/.git-credentials` (HTTPS) and `~/.config/gh/` (for `gh`).",
  "",
  "### Commits on `gallivant/seo-measurement-canonical-repair`",
  "",
  "```",
  "cce35fa docs: add the SEO measurement and canonical repair PRD",
  "af4bd16 fix(analytics): send exactly one GA4 pageview per view",
  "```",
  "",
  "### Verification",
  "",
  "| Command | Result |",
  "|---|---|",
  "| `pnpm --dir web run type-check` | passes, `tsc --noEmit` clean |",
  "| `vitest run functions web/src` | 77 files, **741 tests passed** |",
].join("\n");

const summaryRows = (renderLine, text) =>
  renderLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 1.5 }), { harness: "claude" });

test("the final summary's markdown blocks render as blocks, not as the characters the model typed", async () => {
  const { renderLine } = await served(world());
  const html = summaryRows(renderLine, SUMMARY);

  // A fence is ONE <pre>, with its body verbatim. This is the fix with the most value in it: every line of a fenced
  // block used to go through the inline pass, which reads a `*` as emphasis and deletes the asterisks, so a glob or a
  // pointer inside a code block came out with characters missing.
  const pres = [...html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map(m => m[1]);
  assert.equal(pres.length, 1, "one fence in, one <pre> out");
  assert.equal(pres[0], "cce35fa docs: add the SEO measurement and canonical repair PRD\naf4bd16 fix(analytics): send exactly one GA4 pageview per view",
    "the fence body is the lines the model wrote, newlines and all, and the backtick lines are not in it");
  assert.ok(!/<b>|<i>|<code>|<a /.test(pres[0]), "nothing inside a fence is markdown, because inside a fence nothing is");

  // A pipe table is a real table, inside a container that scrolls on its own so a wide table does not widen the pane.
  assert.match(html, /<div class="tw"><table class="md">/, "the table has its own scroll container");
  assert.match(html, /<thead><tr><th>Command<\/th><th>Result<\/th><\/tr><\/thead>/, "the header row is the header");
  assert.match(html, /<td><code>pnpm --dir web run type-check<\/code><\/td>/, "inline markdown still runs inside a cell");
  assert.match(html, /<b>741 tests passed<\/b>/, "and bold in a cell is bold");
  assert.ok(!/\|---\|/.test(html), "the separator row is structure and is not drawn as text");
  // The pipes themselves are gone: a row of literal pipes is what the reader was complaining about seeing.
  assert.ok(!/<div class="ll">\| /.test(html), "no row is a line of pipes");

  // The headings are rows, and the prose between the blocks still reads as prose.
  assert.match(html, /<div class="ll"><b>Verification<\/b><\/div>/);
  assert.match(html, /sandbox denies: <code>~\/\.git-credentials<\/code>/, "a wrapped paragraph joins and keeps its code spans");
});

test("a list is one list, nested where the model indented it, and a rule is its own row", async () => {
  const { renderLine } = await served(world());
  const prose = text => renderLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }), { harness: "claude" });

  // A run of bullets is one <ul>. Before this, each was its own row starting with a literal dash.
  assert.equal(prose("- one\n- two\n- three"),
    `<div class="ll blk"><ul class="md"><li>one</li><li>two</li><li>three</li></ul></div>`);
  // A `*` bullet and a `+` bullet are the same list as a `-` bullet, which is what markdown says they are.
  assert.match(prose("* a\n+ b"), /<ul class="md"><li>a<\/li><li>b<\/li><\/ul>/);
  // An indented item is nested by a class rather than by a nested list: `report` measured the indent, and at the two
  // or three levels a log pane ever shows an indent reads the same without a tree built from agent output.
  assert.match(prose("- top\n  - under\n- top again"),
    /<li>top<\/li><li class="d1">under<\/li><li>top again<\/li>/);
  // A wrapped item is one item. Starting a new one for the continuation would read as a list twice as long.
  assert.match(prose("- a long item that the model\n  wrapped onto a second line\n- next"),
    /<li>a long item that the model wrapped onto a second line<\/li><li>next<\/li>/);
  // A bullet list and a numbered list are two lists: one <ol> holding bullets would lie about what was written.
  const mixed = prose("- bullet\n1. number");
  assert.match(mixed, /<ul class="md"><li>bullet<\/li><\/ul>/);
  assert.match(mixed, /<ol class="md"><li>number<\/li><\/ol>/);

  // A rule is its own row. It used to be at risk of being read as a table's separator row or as emphasis.
  assert.match(prose("above\n\n---\n\nbelow"), /<div class="ll">above<\/div><div class="ll hr"><\/div><div class="ll">below<\/div>/);
  assert.ok(!/<i>|<b>/.test(prose("---")), "a rule is not emphasis");
  // The spaced spellings are rules too, and `* * *` in particular must not become a bullet list holding `* *`.
  for (const r of ["***", "___", "* * *", "- - -"]) assert.match(prose(r), /^<div class="ll hr"><\/div>$/, `${r} is a rule`);
  // Two markers are not a rule, so a line that is genuinely a bullet keeps being one.
  assert.match(prose("* *"), /<ul class="md"><li>\*<\/li><\/ul>/, "a rule needs three markers, so `* *` stays a bullet");
});

test("a run of quoted lines is one blockquote, and the quote's own markdown still reads", async () => {
  const { renderLine } = await served(world());
  const prose = text => renderLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }), { harness: "claude" });

  // Three `>` lines are one quote, not three rows with the marker stripped off each and nothing saying they were
  // quoted at all, which is what the renderer used to do.
  assert.equal(prose("> the reviewer said\n> the redirect is wrong\n> and it is"),
    `<div class="ll blk"><blockquote><p>the reviewer said the redirect is wrong and it is</p></blockquote></div>`);
  // A blank quoted line is a paragraph break inside the quote.
  assert.match(prose("> first\n>\n> second"), /<blockquote><p>first<\/p><p>second<\/p><\/blockquote>/);
  // Inline markdown inside a quote is still inline markdown.
  assert.match(prose("> the **build** is `red`"), /<p>the <b>build<\/b> is <code>red<\/code><\/p>/);
});

test("a block that is half arrived degrades to what it holds rather than swallowing the rest", async () => {
  const { renderLine } = await served(world());
  const prose = text => renderLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }), { harness: "claude" });

  // The case streaming makes ordinary: the fence opened and its closer has not arrived. It must not throw and it must
  // not eat the rest of the event. The lines it holds render as the <pre> they will become, marked as still open.
  const open = prose("here is the diff\n\n```js\nconst x = 1;\nconst y = 2;");
  assert.match(open, /<div class="ll">here is the diff<\/div>/, "what came before the fence is untouched");
  assert.match(open, /<div class="ll fence open" data-lang="js"><pre>const x = 1;\nconst y = 2;<\/pre><\/div>/,
    "the code that did arrive is on screen, and the row says the block is still open");

  // A pipe table whose separator row has not arrived is not a table: without a ruler it is prose that contains pipes,
  // which is exactly what it looks like. It must not become a one-column table and must not swallow what follows.
  const ragged = prose("| Command | Result |");
  assert.ok(!/<table/.test(ragged), "no ruler, no table");
  assert.match(ragged, /<div class="ll">\| Command \| Result \|<\/div>/, "the line is shown as itself instead");

  // A fence whose closer DID arrive is not marked open, so the two cases are told apart on the page.
  assert.ok(!/fence open/.test(prose("```\nx\n```")), "a closed fence is not marked open");

  // A table with ragged column counts is padded and clipped to the header's width, so the columns stay aligned rather
  // than the browser reflowing per row.
  const table = prose("| a | b |\n|---|---|\n| only one |\n| one | two | three |");
  const rows = [...table.matchAll(/<tr>(?:<td>.*?<\/td>)+<\/tr>/g)].map(m => m[0]);
  assert.deepEqual(rows, ["<tr><td>only one</td><td></td></tr>", "<tr><td>one</td><td>two</td></tr>"],
    "a short row gains an empty cell and a long row loses the overflow");

  // A pipe inside inline code inside a cell is a pipe, not a cell boundary, when the model escaped it.
  assert.match(prose("| cmd | note |\n|---|---|\n| `a \\| b` | piped |"),
    /<td><code>a \| b<\/code><\/td><td>piped<\/td>/, "an escaped pipe stays a character in the cell");
});

test("a block is exactly one row, so the cap, the trim and the history prepend still count what they counted", async () => {
  const { renderLine } = await served(world());

  // Why a block cannot span the boundary between prepended history and the live tail, which is the case most likely to
  // break: a log line is one whole JSON event, so the markdown a model wrote arrives complete inside one line. The
  // history route serves whole lines and the stream sends whole lines, so a fence is never half in one and half in the
  // other. The only half-arrived block is one the MODEL left open inside its own event, which is the case above.
  //
  // What the pane needs from that is the row count. `paint` counts the pane's children for MAX_LINES, `trim` indexes
  // past the `loaded` history rows, and `loadEarlier` adds `childElementCount` to `loaded`. All three break if one
  // line can produce a row that is not a direct child, so every block renders as exactly one top-level `<div class=
  // "ll ...">` and a table's six visual rows stay one row of the pane's budget.
  const many = ["# head", "", "- a", "- b", "", "```", "x", "```", "", "| c |", "|---|", "| v |", "", "> q", "", "---", "", "tail"].join("\n");
  const html = summaryRows(renderLine, many);
  // Count top-level children the way the browser will, rather than by regex: the same parse the pane does.
  const depth = [];
  let top = 0;
  for (const [, close, name] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g)) {
    if (close) { depth.pop(); continue; }
    if (depth.length === 0) top++;
    // `<pre>` and the rest nest; nothing here is a void element, so every open tag has a close.
    depth.push(name);
  }
  assert.equal(depth.length, 0, "every tag the blocks wrote is closed, or the pane's prepend would nest rows");
  // A heading, a list, a fence, a table, a quote, a rule, a paragraph, and the closing line: eight rows for eight
  // blocks, however many <li> or <td> are inside them.
  assert.equal(top, 8, "one row per block, so a table is one row of the cap and not six");
  for (const [, cls] of html.matchAll(/^|<div class="(ll[^"]*)"/g)) if (cls) assert.match(cls, /^ll\b/, "every top-level row is an .ll row");
});

test("hostile markdown inside every block type is escaped, and no block opens an attribute hole", async () => {
  const { renderLine } = await served(world());
  const prose = text => renderLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }), { harness: "claude" });

  for (const payload of [
    "| cell |\n|---|\n| <script>alert(1)</script> |",              // a script in a table cell
    "| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | ok |",  // and an image with a handler
    "```\njavascript:alert(document.cookie)\n```",                  // a javascript: URL in a fence
    "```<script>alert(1)</script>\nbody\n```",                      // markup where the language word goes
    '```" onload="alert(1)\nbody\n```',                             // a language that tries to close the attribute
    "- <img src=x onerror=alert(1)>",                               // in a list item
    "1. <iframe src=//evil></iframe>",                              // in a numbered one
    "  - <svg onload=alert(1)>",                                    // and in a nested one
    "> <script>alert(1)</script>",                                  // in a blockquote
    "```\nconst x = 1;",                                            // a fence that never closes
    "| <script>x</script> |",                                       // a pipe line with no ruler under it
    "---\n<script>alert(1)</script>",                               // next to a rule
    "| a |\n|---|\n| [x](javascript:alert(1)) |",                   // a link markdown was asked to build, in a cell
    "| a |\n|---|\n| `<b onmouseover=alert(1)>` |",                 // markup inside a code span inside a cell
  ]) {
    const html = prose(payload);
    for (const [, name, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
      // The blocks add six tags to the six the inline renderer already wrote. Nothing else may appear.
      assert.ok(["div", "span", "a", "b", "i", "code", "pre", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "p"].includes(name),
        `${JSON.stringify(payload)} produced a <${name}>`);
      const keys = [...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(m => m[1]);
      assert.ok(!keys.some(k => /^on/i.test(k)), `${JSON.stringify(payload)} produced an event handler: ${attrs}`);
      const href = /href="([^"]*)"/.exec(attrs);
      assert.ok(!href || /^https?:\/\//.test(href[1]), `${JSON.stringify(payload)} produced a non-http href: ${href?.[1]}`);
      // `data-lang` is the only attribute a block writes from the model's own text, so it is the one to pin down.
      const lang = /data-lang="([^"]*)"/.exec(attrs);
      assert.ok(!lang || /^[a-z0-9+#-]{1,20}$/.test(lang[1]), `${JSON.stringify(payload)} produced a data-lang of ${lang?.[1]}`);
    }
    assert.ok(!/<script|<img|<iframe|<svg|<object/i.test(html), `${JSON.stringify(payload)} produced a tag it asked for`);
  }

  // A language word the whitelist refuses is dropped rather than escaped into the attribute: the fence still renders,
  // it just carries no language. The body is what the reader needed and it is on the page.
  const bad = prose('```" onload="x\nconst a = 1;\n```');
  assert.ok(!/data-lang/.test(bad), "a language that is not a word is left off entirely");
  assert.match(bad, /<pre>const a = 1;<\/pre>/, "and the block still shows its body");

  // Every character inside a fence survives, including the ones the inline pass would have eaten. This is the defect
  // the reader hit: `*` and `_` deleted from code because a fence was being run through the emphasis regexes.
  const kept = prose("```\nls *.ts && cat a_b_c.md && x = *p;\n```");
  assert.match(kept, /<pre>ls \*\.ts &amp;&amp; cat a_b_c\.md &amp;&amp; x = \*p;<\/pre>/,
    "the asterisks and the underscores are still there, and the ampersands are escaped");
});

test("the raw kind is still raw: block rendering never reaches a line nobody wrote as markdown", async () => {
  const { renderLine, parseLine } = await served(world());

  // A harness's own stderr falls through to `raw`, which exists so `md` cannot eat characters from it. Adding block
  // rendering must not have routed it through the block pass: these lines look like markdown and are not.
  for (const line of [
    "Error: --add-dir *cannot* be used with __proto__",
    "  - npm ERR! missing script",
    "| col | col |",
    "```",
    "> stderr said this",
    "---",
  ]) {
    assert.equal(parseLine(line, { harness: "claude" }).kind, "raw", `${JSON.stringify(line)} is raw`);
    const html = renderLine(line, { harness: "claude" });
    assert.match(html, /^<div class="ll raw">/, `${JSON.stringify(line)} renders as a raw row`);
    assert.ok(!/<ul|<ol|<pre|<table|<blockquote|<b>|<i>/.test(html), `${JSON.stringify(line)} was given markup it did not ask for`);
  }
  // The characters the old defect deleted are all still on the page.
  assert.match(renderLine("Error: --add-dir *cannot* be used with __proto__", { harness: "claude" }),
    /--add-dir \*cannot\* be used with __proto__/);
});

// ---- heartbeats, the whole history, and the range route -------------------------

/**
 * A `tool_progress` heartbeat, verbatim from the real run apart from the trimmed session and uuid.
 *
 * Claude Code sends one of these every 30 seconds for a tool that has not returned. Twenty-one of them are in the run
 * tree this was read off, fourteen of them for one `npm ci`.
 */
const beatLine = (of, secs, i = 0) => JSON.stringify({
  type: "tool_progress", tool_use_id: `${of}-heartbeat-${i}`, tool_name: "Bash", parent_tool_use_id: of,
  elapsed_time_seconds: secs, heartbeat: true, session_id: "fb6b8691-7805-45ac-b4c3-06c2f4f24184",
  uuid: "4c8564cd-32a7-4169-8d8f-1d346d5e281b",
});

/** The call those heartbeats belong to, with the tool_use_id the real event carries. */
const CALL = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "toolu_015QT9vppkHkPqXjJdT6rr8W", name: "Bash", input: { command: "npm ci" } }] },
});

test("a heartbeat names the row it updates rather than drawing a row of its own", async () => {
  const { parseLine, renderLine } = await served(world());

  // Twenty-one identical rows would be noise and skipping them would throw away the one thing the reader wanted, so a
  // heartbeat is neither: it is an update, and it says which row it updates.
  assert.deepEqual(parseLine(beatLine("toolu_015QT9vppkHkPqXjJdT6rr8W", 390, 12), { harness: "claude" }),
    { kind: "beat", of: "toolu_015QT9vppkHkPqXjJdT6rr8W", tool: "Bash", secs: 390 });

  // The call carries its own id, which is how the heartbeat finds it.
  assert.match(renderLine(CALL, { harness: "claude" }), /data-id="toolu_015QT9vppkHkPqXjJdT6rr8W"/);
  // A call with no id in the stream is the row it always was, byte for byte.
  assert.equal(renderLine(TOOL_USE, { harness: "claude" }),
    '<div class="ll t shell"><span class="n">Bash</span><span class="a">ls &amp;&amp; echo &quot;---&quot; &amp;&amp; ls docs/prds/</span></div>');

  // Rendered on its own (its row is gone, or the pane opened mid-call) it says the elapsed time, because a Bash step
  // alive for six minutes with nothing on screen is the complaint this answers.
  assert.match(renderLine(beatLine("toolu_x", 390), { harness: "claude" }), /running 6m 30s/);
  assert.match(renderLine(beatLine("toolu_x", 30), { harness: "claude" }), /running 30s/);
  // A heartbeat with no usable elapsed time still says the call is alive rather than printing NaN.
  assert.match(renderLine(JSON.stringify({ type: "tool_progress", parent_tool_use_id: "toolu_x", tool_name: "Bash" }), { harness: "claude" }), /<span class="a">running<\/span>/);

  // A hostile tool name cannot become markup on the heartbeat's own row either.
  const nasty = renderLine(JSON.stringify({ type: "tool_progress", parent_tool_use_id: "<script>x</script>", tool_name: "<img src=x onerror=alert(1)>", elapsed_time_seconds: 30 }), { harness: "claude" });
  assert.ok(!/<script|<img/i.test(nasty), "a heartbeat's tool name is escaped like everything else");
  for (const [, , attrs] of nasty.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g))
    assert.ok(!/\bon[a-z]+\s*=/i.test(attrs), "no event handler from a heartbeat");
});

test("every line of a realistic run renders: no shape is left as raw JSON", async () => {
  const { parseLine } = await served(world());
  // One of each event shape the six real logs under ~/.gallivant/runs hold, trimmed. `tool_progress` and the harness's
  // own stderr were the two that came back null before this change; the rest already read.
  const log = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "522acaae", cwd: "/tmp/wt" }),
    JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" }),
    JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", outcome: "success", output: "", exit_code: 0 }),
    JSON.stringify({ type: "system", subtype: "task_started", description: "Install workspace deps" }),
    JSON.stringify({ type: "system", subtype: "task_notification", summary: "deps installed", status: "completed" }),
    TEXT_BLOCK,
    CALL,
    beatLine("toolu_015QT9vppkHkPqXjJdT6rr8W", 30, 0),
    beatLine("toolu_015QT9vppkHkPqXjJdT6rr8W", 420, 13),
    RESULT_OK,
    DENIAL,
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "output_tokens", status: "allowed" } }),
    "Error: Input must be provided either through stdin or as a prompt argument when using --print",
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Pushed the fix.", total_cost_usd: 1.4832 }),
  ];
  const unrendered = log.filter(line => {
    const p = parseLine(line, { harness: "claude" });
    // `raw` is the fallback, so a line that lands there is one nothing claimed. `skip` is a decision, not a failure.
    return [].concat(p).some(row => row.kind === "raw");
  });
  // The one raw line is the harness's own stderr, and raw is the right answer for it: nothing invented a field name
  // for it, and it keeps every character it had. It is not a JSON event and never will be.
  assert.deepEqual(unrendered, ["Error: Input must be provided either through stdin or as a prompt argument when using --print"]);
  for (const line of log) {
    const rows = [].concat(parseLine(line, { harness: "claude" }));
    assert.ok(rows.every(r => r && r.kind), `${line.slice(0, 60)} produced a row with no kind`);
    assert.ok(!rows.some(r => r.kind === "raw" && /^\{/.test(r.text)), `${line.slice(0, 60)} is still raw JSON on the page`);
  }
});

test("the history route serves a bounded window of a run's log, older than the tail", async () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`);
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines, exit: 0, endedAt: Date.parse(T0) + 10 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const get = async path => { const r = res(); handle(w.ctx, req(path), r); await r.ended; return { code: r.code, body: JSON.parse(r.body()) }; };
  const base = `/api/run/history?id=${encodeURIComponent(ID)}`;

  // No `before` means the window the tail did not send, which is what a page that opened on the tail wants first.
  const first = await get(base);
  assert.equal(first.code, 200);
  assert.equal(first.body.total, 1200);
  assert.equal(first.body.lines.length, TAIL, "one window, bounded by the same TAIL the stream uses");
  assert.equal(first.body.to, 1200 - TAIL, "it ends where the tail begins, so nothing is shown twice");
  assert.equal(first.body.from, 1200 - 2 * TAIL + 1);
  assert.equal(first.body.before, 1200 - 2 * TAIL, "and says how many are older still");
  assert.equal(first.body.lines[0], `line ${1200 - 2 * TAIL + 1}`);
  assert.equal(first.body.lines.at(-1), `line ${1200 - TAIL}`);

  // Reaching back again from the id the last answer gave, until the first line of the run. "logs between all start
  // and stops" is the whole file, and the whole file is what this walks: job.log is opened once per run and never
  // rotated, so the last window really is the run's first line. 1200 lines is a tail and two windows exactly.
  const second = await get(`${base}&before=${first.body.from}`);
  assert.equal(second.body.from, 1, "the last window starts at the first line the run ever wrote");
  assert.equal(second.body.lines[0], "line 1");
  assert.equal(second.body.before, 0, "and nothing is older, so the control goes away");
  const third = await get(`${base}&before=${second.body.from}`);
  assert.deepEqual(third.body.lines, [], "there is nothing before the first line");
  assert.deepEqual([...new Set([...first.body.lines, ...second.body.lines])].length, 1200 - TAIL,
    "the two windows plus the tail are the whole log, with no line served twice");

  // Clamped rather than rejected at both ends: asking for line 0 or line ten million of a 1200-line log is asking for
  // the start and for the end, and answering that beats a 400 the page would have to special-case.
  assert.deepEqual((await get(`${base}&before=1`)).body.lines, []);
  assert.deepEqual((await get(`${base}&before=0`)).body.lines, []);
  assert.deepEqual((await get(`${base}&before=-40`)).body.lines, []);
  assert.equal((await get(`${base}&before=10000000`)).body.to, 1200, "past the end is the end");
  // A `before` that is not a number is a broken link, not a request for the start of the file.
  assert.equal((await get(`${base}&before=abc`)).code, 400);
  assert.equal((await get(`${base}&before=${encodeURIComponent("../../etc")}`)).code, 400);

  // A run whose whole log fitted in the tail has nothing older, and says so rather than repeating the tail.
  const small = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["one", "two"], exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const r = res();
  handle(small.ctx, req(`/api/run/history?id=${encodeURIComponent(ID)}`), r);
  await r.ended;
  assert.deepEqual(JSON.parse(r.body()).lines, []);
  assert.equal(JSON.parse(r.body()).before, 0);
});

test("the history route refuses a traversal and an unknown id, the same way the stream does", async () => {
  const lines = Array.from({ length: 900 }, (_, i) => `secret ${i}`);
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines, exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const get = async path => { const r = res(); handle(w.ctx, req(path), r); await r.ended; return r; };

  // The same entry ids the stream's traversal test uses. An entry id contains slashes, so it is checked against the
  // registry rather than by pattern, and nothing the query string holds is joined to a path.
  for (const id of ["../../../../etc/passwd", "..%2f..%2f..%2fetc%2fpasswd", "acme/widget/../../../../etc", "/etc/passwd", "acme/widget/widget-export/../../.."]) {
    const r = await get(`/api/run/history?id=${encodeURIComponent(id)}`);
    assert.equal(r.code, 404, `id=${id} must be refused`);
    assert.ok(!r.body().includes("root:"), "nothing outside the run tree is ever read");
    assert.ok(!r.body().includes("secret"), "and not this run's log either");
  }
  // And the run id, which is the half that does get joined to a path once the entry is known.
  for (const run of ["../../../../etc/passwd", "..", ".", "a/../b", "job.log"]) {
    const r = await get(`/api/run/history?id=${encodeURIComponent(ID)}&run=${encodeURIComponent(run)}`);
    assert.equal(r.code, 404, `run=${run} must be refused`);
  }
  // An unregistered entry with a legitimate run id reaches nothing.
  assert.equal((await get(`/api/run/history?id=${encodeURIComponent("acme/widget/not-registered")}&run=2026-09-24T02-00-00-000-fix`)).code, 404);
  // A source label nobody configured reaches no tree either.
  assert.equal((await get(`/api/run/history?source=nope&run=2026-09-24T02-00-00-000-fix`)).code, 404);
  assert.equal((await get(`/api/run/history?source=${encodeURIComponent("../../../etc")}&run=2026-09-24T02-00-00-000-fix`)).code, 404);
  // And the route is a GET like every other: nothing here writes.
  const post = res();
  handle(w.ctx, { ...req(`/api/run/history?id=${encodeURIComponent(ID)}`), method: "POST" }, post);
  await post.ended;
  assert.equal(post.code, 404, "only GET is routed");
});

test("hostile log content survives the history route as text, and becomes no markup", async () => {
  const payloads = [
    `<script>alert("xss")</script>`,
    `<img src=x onerror="alert(2)">`,
    `Error: reading __proto__ and *.test.mjs failed`,
    `see http://evil.example/"onmouseover="alert(1)`,
  ];
  // Enough lines that the tail does not cover them, so the history route is the only way they reach the page.
  const lines = [...payloads, ...Array.from({ length: TAIL + 10 }, (_, i) => `line ${i}`)];
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines, exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  const r = res();
  handle(w.ctx, req(`/api/run/history?id=${encodeURIComponent(ID)}`), r);
  await r.ended;
  const got = JSON.parse(r.body());
  // The route is JSON and carries the bytes the agent printed. Escaping is the renderer's job, at the point the text
  // becomes markup, which is the same contract the stream has.
  assert.deepEqual(got.lines.slice(0, payloads.length), payloads, "the window carries what the harness wrote");

  // Through the renderer, which is where it becomes markup.
  const { renderLine } = await served(w);
  for (const payload of got.lines.slice(0, payloads.length)) {
    const html = renderLine(payload, { harness: "claude" });
    assert.notEqual(html, "", `${payload} must not vanish`);
    for (const [, name, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
      assert.ok(["div", "span", "a"].includes(name), `${payload} produced a <${name}>`);
      const keys = [...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(m => m[1]);
      assert.ok(!keys.some(k => /^on/i.test(k)), `${payload} produced an event handler: ${attrs}`);
      const href = /href="([^"]*)"/.exec(attrs);
      assert.ok(!href || /^https?:/.test(href[1]), `${payload} produced a non-http href`);
    }
    assert.ok(!/<script|<img/i.test(html), `${payload} produced a tag it asked for`);
  }
  // The identifier and the glob are still on the page, which is the whole point of the raw row.
  assert.match(renderLine(got.lines[2], { harness: "claude" }), /__proto__/);
  assert.match(renderLine(got.lines[2], { harness: "claude" }), /\*\.test\.mjs/);
});

test("the pane offers the history and the stream keeps its tail, with nothing served twice", async () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`);
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines, exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });

  // The control is in the markup rather than created by the script, disabled until the stream says how many lines it
  // skipped. Both panes that hold a log get it: the entry page and the runs view.
  for (const path of [`/run?id=${encodeURIComponent(ID)}`, `/runs?open=2026-09-24T02-00-00-000-fix`]) {
    const r = res();
    handle(w.ctx, req(path), r);
    await r.ended;
    assert.match(r.body(), /<button type="button" id="earlier" disabled hidden>/, `${path} renders the control disabled`);
    assert.match(r.body(), /id="earlierstate"/, `${path} has somewhere to say how many are hidden`);
    assert.match(r.body(), /id="log" /, `${path} still has the pane`);
  }

  // The stream is unchanged: the tail on open, the skipped count, ids that are positions in the whole log.
  const s = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`), s);
  await s.ended;
  assert.equal(s.lines().length, TAIL, "the tail is still the tail");
  assert.equal(Number(s.frames.find(f => f.event === "skipped").value), 1200 - TAIL);
  assert.equal(s.lines()[0], `line ${1200 - TAIL + 1}`, "and starts where the skipped count says it does");

  // The first line the pane holds is skipped + 1, which is exactly what the history route takes as `?before=`, so the
  // window it answers with ends on the line before the tail and nothing is served twice.
  const h = res();
  handle(w.ctx, req(`/api/run/history?id=${encodeURIComponent(ID)}&before=${1200 - TAIL + 1}`), h);
  await h.ended;
  const got = JSON.parse(h.body());
  assert.equal(got.lines.at(-1), `line ${1200 - TAIL}`, "the window ends one line before the tail begins");
  assert.ok(!got.lines.includes(s.lines()[0]), "and holds no line the stream already sent");

  // A resume still resumes rather than replaying, which the history route must not have disturbed.
  const again = sink();
  handle(w.ctx, req(`/api/run/output?id=${encodeURIComponent(ID)}`, { "last-event-id": "1190" }), again);
  await again.ended;
  assert.equal(again.lines().length, 10);
  assert.ok(!again.frames.some(f => f.event === "skipped"), "a resume is not a truncation and must not claim one");
});

test("the pane corrects its scroll after prepending, and the cap spares what the reader loaded", async () => {
  const w = world();
  const r = res();
  handle(w.ctx, req("/tracker.js"), r);
  await r.ended;
  const js = r.body();

  // Prepending to a scrolled container is what makes this kind of control feel broken: the browser keeps scrollTop,
  // measured from the top, so content inserted above slides what the reader was reading down out of view. The height
  // is measured before and after and the difference added back, which leaves the same pixels under the same line.
  assert.match(js, /const before = pane\.scrollHeight, top = pane\.scrollTop;/, "the height is measured before the insert");
  assert.match(js, /pane\.scrollTop = top \+ \(pane\.scrollHeight - before\);/, "and the difference is added back after it");
  assert.ok(js.indexOf("pane.prepend") < js.indexOf("pane.scrollTop = top +"), "the correction comes after the insert, not before");

  // The cap. MAX_LINES bounds a DOM that an unbounded live stream would grow forever; history the reader asked for is
  // exempt, because the only thing that could fetch it back is the button they just pressed. So the budget grows by
  // what was loaded, and a trim that still reaches into history says so rather than letting rows vanish silently.
  assert.match(js, /const MAX_LINES = 2000;/, "the live cap is unchanged");
  assert.match(js, /pane\.childElementCount > MAX_LINES \+ loaded/, "the budget grows by exactly what was loaded");
  assert.match(js, /loaded \+= t\.content\.childElementCount/, "counted in rows, since one line can be several or none");
  // And the trim starts after the history block rather than at the top. Trimming from the top looks right and is
  // wrong: history sits above the live tail, so the top IS the history and a growing budget only delays eating it.
  assert.match(js, /const victim = pane\.children\[loaded\];/, "the oldest LIVE row is the one dropped, not the oldest row");

  // The rows go into the pane itself rather than a wrapper per frame. A wrapper made one paint of three hundred lines
  // count as a single child, so the cap never fired and the DOM grew without bound on a long run.
  assert.ok(!/frag\.innerHTML = pending\.map/.test(js), "no wrapper div per painted frame");
  assert.match(js, /pane\.append\(t\.content\)/, "a template's content is appended, so each row is its own child");

  // The history fetch goes to the read route, never to the stream, and addresses the run the way the pane was told to.
  assert.match(js, /BASE \+ "\/api\/run\/history\?"/, "the range route is a read, not the SSE endpoint");
  assert.match(js, /h\.set\("before", String\(oldest\)\)/, "and asks for the window before what it holds");
  assert.match(js, /new EventSource\(url\)/, "the live stream is untouched");
});

/**
 * A fake DOM, just enough to run the pane's own wiring out of the served script.
 *
 * The renderer is tested by calling its functions; the pane is not, and the two things most likely to reach a reader
 * as a bug (a prepend that jumps the scroll, a cap that eats what they loaded) live in the wiring rather than in the
 * renderer. So this is a document with the four operations the pane uses: a children list, a template whose innerHTML
 * becomes rows, textContent, and a scrollHeight that is the row count so the correction can be checked arithmetically.
 */
function fakeDom() {
  class El {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ""; this._text = ""; this.hidden = false; this.disabled = false; this.content = null; this._on = {}; }
    set innerHTML(v) {
      // Rows are top-level <div class="ll...">. Splitting on the opening tag is enough: the renderer writes no nested
      // div and the test only needs the count and each row's class and text.
      const parts = String(v).split(/(?=<div class=")/).filter(Boolean);
      const kids = parts.map(p => { const e = new El("div"); e.className = /<div class="([^"]*)"/.exec(p)?.[1] || ""; e._text = p; return e; });
      if (this.tagName === "template") { this.content = new El("div"); this.content.children = kids; } else this.children = kids;
    }
    set textContent(v) { this._text = String(v); } get textContent() { return this._text; }
    append(c) { if (c instanceof El && c.tagName === "div" && c.content === null && c.children.length && c.className === "") this.children.push(...c.children); else if (c instanceof El) this.children.push(c); }
    prepend(c) { if (c instanceof El && c.children.length && c.className === "") this.children.unshift(...c.children); else this.children.unshift(c); }
    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0]; }
    remove() { const i = this.parent?.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); }
    querySelectorAll(sel) {
      if (sel.includes("[data-id]")) return this.children.filter(c => c.dataset.id);
      return [];
    }
    querySelector(sel) { return this.children.find(c => sel.includes(c.className)) || null; }
    addEventListener(n, f) { this._on[n] = f; }
    setAttribute() {}
    // One row is one unit of height, so the scroll correction is checkable as arithmetic rather than as pixels.
    get scrollHeight() { return this.children.length; }
    get clientHeight() { return 5; }
  }
  // remove() needs a parent link, and the pane is the only thing that removes.
  const pane = new El("div");
  const origAppend = El.prototype.append;
  El.prototype.append = function (c) { origAppend.call(this, c); for (const k of this.children) k.parent = this; };
  El.prototype.prepend = function (c) { const kids = c.children?.length && c.className === "" ? c.children : [c]; this.children.unshift(...kids); for (const k of this.children) k.parent = this; };
  pane.dataset.harness = "claude"; pane.dataset.run = "2026-09-24T02-00-00-000-fix"; pane.dataset.entry = ID;
  const els = { log: pane, logstate: new El("p"), earlier: new El("button"), earlierstate: new El("span"), side: null, filter: null, matches: null, groupby: null };
  let source = null;
  const doc = {
    body: { dataset: { base: "" } },
    getElementById: id => els[id] ?? null,
    createElement: t => new El(t),
  };
  const frames = [];
  class FakeES {
    constructor(u) { this.url = u; source = this; this.readyState = 1; this._on = {}; }
    addEventListener(n, f) { this._on[n] = f; }
    close() { this.readyState = 2; }
  }
  return { doc, pane, els, frames, FakeES, es: () => source, El };
}

/** Run the whole served script against a fake document, and hand back the pane plus a way to feed it frames. */
async function paneOf(w, { fetchJson = async () => ({ lines: [], before: 0, from: 1 }) } = {}) {
  const r = res();
  handle(w.ctx, req("/tracker.js"), r);
  await r.ended;
  const dom = fakeDom();
  const rafs = [];
  const sandbox = {
    document: dom.doc, EventSource: dom.FakeES,
    localStorage: { getItem: () => null, setItem() {} },
    location: { href: "http://127.0.0.1/run" },
    requestAnimationFrame: f => rafs.push(f),
    URLSearchParams, URL, Number, Math, Array, JSON, String, Object, Boolean, isNaN, parseInt, parseFloat,
    fetch: async url => ({ ok: true, status: 200, json: async () => fetchJson(String(url)) }),
    console,
  };
  const names = Object.keys(sandbox);
  new Function(...names, r.body())(...names.map(n => sandbox[n]));
  const flush = () => { while (rafs.length) rafs.shift()(); };
  return { ...dom, flush, line: text => { dom.es()._on ? null : null; dom.es().onmessage({ data: JSON.stringify(text) }); }, };
}

test("prepending history leaves the reader looking at the same line, and the cap spares it", async () => {
  const w = world({ runs: { "2026-09-24T02-00-00-000-fix": { lines: ["one"], exit: 0, endedAt: 1 } }, latest: "2026-09-24T02-00-00-000-fix" });
  // 40 lines of history for the button to fetch, and a stream that says 40 lines were skipped.
  const history = Array.from({ length: 40 }, (_, i) => `older ${i + 1}`);
  const p = await paneOf(w, { fetchJson: () => ({ lines: history, from: 1, before: 0, total: 440, to: 40 }) });

  // The tail arrives, then the skipped frame. The control is offered because 40 lines are hidden.
  p.es()._on.skipped({ data: "40" });
  for (let i = 0; i < 20; i++) p.es().onmessage({ data: JSON.stringify(`line ${i}`) });
  p.flush();
  assert.equal(p.els.earlier.hidden, false, "the control appears once the stream says lines are hidden");
  assert.equal(p.els.earlier.disabled, false);
  assert.match(p.els.earlierstate.textContent, /40 earlier lines not shown yet/);

  const rowsBefore = p.pane.childElementCount;
  // The reader has scrolled up to read something. scrollHeight is the row count in this document, so the correction is
  // checkable: after prepending 40 rows, scrollTop must have moved up by exactly 40 to keep the same rows in view.
  p.pane.scrollTop = 7;
  await p.els.earlier._on.click();
  assert.equal(p.pane.childElementCount, rowsBefore + 40, "the window is on the page");
  assert.equal(p.pane.children[0].className.split(" ")[0], "ll", "prepended, so the oldest is first");
  assert.equal(p.pane.scrollTop, 47, "and the scroll moved by exactly the height that was inserted, so nothing jumped");
  assert.match(p.els.earlierstate.textContent, /first line of the run/, "and the control says there is nothing older");
  assert.equal(p.els.earlier.hidden, true);

  // The cap. Push enough live lines to blow past MAX_LINES and check that the 40 loaded rows are still there: the
  // budget is MAX_LINES plus what was loaded, so a burst of live output cannot undo the click.
  for (let i = 0; i < 2100; i++) p.es().onmessage({ data: JSON.stringify(`flood ${i}`) });
  p.flush();
  assert.equal(p.pane.childElementCount, 2040, "the cap is MAX_LINES plus the rows the reader loaded");
  assert.ok(p.pane.children[0]._text.includes("older 1"), "the oldest row is still the history they asked for");
  assert.ok(p.pane.children[39]._text.includes("older 40"), "all forty of it, untouched by the flood");
  assert.ok(p.pane.children.at(-1)._text.includes("flood 2099"), "and the newest live line is still the last row");
  // What went instead: the oldest LIVE rows, which is the only thing that can go. Trimming from the top would have
  // eaten the history first, which is what a growing budget on its own quietly did.
  assert.ok(!p.pane.children.some(c => c._text.includes("line 0")), "the oldest live rows are the ones that were dropped");
});
