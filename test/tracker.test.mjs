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
import { handle } from "../lib/commands/serve.mjs";
import { listRuns, runDir } from "../lib/tracker/runs.mjs";
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
  assert.match(body, /daemon DOWN/, "no daemon.json means the page says so rather than implying health");
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
  for (const prop of ["--gv-bg", "--gv-fg", "--gv-accent", "--gv-font", "--gv-mono", "--gv-size", "--gv-line", "--gv-radius"])
    assert.ok(css.includes(prop + ":"), `${prop} has a default a parent can override`);
  // font-family takes the parent's where an iframe allows it, with a system stack behind it.
  assert.match(css, /--gv-font: inherit,/);
  // Both directions of the theme override, so a forced palette wins over the system setting either way.
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:root:not\(\[data-theme="light"\]\)/);
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
  // The one place a log line touches the DOM. Assigning it anywhere that parses markup (innerHTML, outerHTML,
  // insertAdjacentHTML, document.write) would make every line the agent prints executable.
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js.body()), "a log line is assigned as text, never parsed as markup");
  assert.match(js.body(), /\.textContent = text/);
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
