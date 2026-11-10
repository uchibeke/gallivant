// Synthetic, versioned comparison data. No makeContext(), user config or daemon.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const NOW = "2026-09-24T14:30:00.000Z";
export const TASK = "acme/atlas/search-index";
export const RUN = "2026-09-24T14-00-00-000-fix";
export const MALICIOUS = '<img src=x onerror="window.injected=true">';

export async function fixture({ runtime = new URL("../../", import.meta.url), empty = false, hostile = false } = {}) {
  if (typeof runtime === "string") runtime = pathToFileURL(`${runtime}/`);
  const [transport, stateModule, runnerModule, configModule] = await Promise.all([
    import(new URL("lib/commands/serve.mjs", runtime)), import(new URL("lib/state.mjs", runtime)),
    import(new URL("lib/run.mjs", runtime)), import(new URL("lib/config.mjs", runtime)),
  ]);
  const home = mkdtempSync(join(tmpdir(), "workspace-ui-"));
  const { makeState, newEntry, idSlug, STATES } = stateModule;
  const state = makeState(home);
  const ctx = {
    home, state, clock: { now: () => Date.parse(NOW) },
    config: { ...configModule.DEFAULTS, home, repos: ["acme/atlas"], max_iterations: 5 },
    log: { latest: () => null, info() {}, warn() {}, error() {} }, readPrd: () => null,
    runnerFor: id => ({ ...runnerModule.makeRunner(join(home, "runs", idSlug(id)), { probe: () => false }),
      start() { throw new Error("UI fixture cannot start execution"); }, kill() { throw new Error("UI fixture cannot kill a process"); },
    }),
  };
  if (!empty) {
    const rows = [
      ["search-index", 42, STATES.needsHuman, "checks-red: search index needs a migration decision"],
      ["keyboard-navigation", 43, STATES.needsHuman, "conflict: review changes to the navigation component"],
      ["activity-feed", 44, STATES.prOpen, null],
      ["export-history", 45, STATES.running, null],
      ["settings-layout", 40, STATES.done, null],
      ["repository-picker", 39, STATES.done, null],
    ];
    rows.forEach(([slug, pr, phase, reason], i) => {
      const id = `acme/atlas/${slug}`;
      state.put(id, { ...newEntry({ prd: `docs/prds/${slug}.md`, repo: "acme/atlas", branch: `work/${slug}`,
        worktree: `/fixture/worktrees/${slug}`, harness: "codex", session: "fixture-session", pr,
        state: phase, nowIso: new Date(Date.parse(NOW) - (i + 1) * 600_000).toISOString() }),
        base: "main", reason: hostile && i === 0 ? `${MALICIOUS} ${"long-path/".repeat(80)}` : reason, iteration: i % 3 + 1,
      });
      const dir = join(home, "runs", idSlug(id), RUN);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "job.json"), JSON.stringify({ id: RUN, name: "fix", bin: "/fixture/no-executable",
        pid: 0, startedAt: Date.parse(NOW) - 1_800_000, endedAt: Date.parse(NOW) - 600_000, exit: 0 }));
      writeFileSync(join(dir, "job.log"), JSON.stringify({ type: "item.completed", item: { type: "agent_message",
        text: hostile ? MALICIOUS : "Fixture run: inspected the search index and recorded the migration decision." } }) + "\n");
      writeFileSync(join(home, "runs", idSlug(id), "latest-run"), RUN);
    });
  }
  const mounted = transport.mount(ctx, { base: "/gallivant", home: { label: "Command Center", url: "/host" } });
  let holdReviewBody = false;
  const server = createServer((req, res) => {
    // Simulate a stalled read after real handler headers, for cancellation tests.
    if (holdReviewBody && new URL(req.url, "http://fixture").pathname.endsWith("/api/run/review-activity")) {
      res.end = body => { res.write(String(body).slice(0, 1)); return res; };
    }
    if (req.url === "/host-tokens.css" || req.url === "/zoom.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(req.url === "/zoom.css" ? "body { zoom: 2; }" : ":root { --gv-canvas: #f0f0f0; --gv-accent: #005c6e; }"); return;
    }
    if (req.url === "/host") { res.end('<!doctype html><html lang="en"><title>Fixture host</title><body><main><h1>Command Center fixture</h1><iframe title="Workspace" src="/gallivant/?theme=dark"></iframe></main></body></html>'); return; }
    Promise.resolve().then(() => mounted.owns(req) ? mounted.handle(req, res) : transport.handle(ctx, req, res))
      .catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
  catch (error) { rmSync(home, { recursive: true, force: true }); throw error; }
  return { ctx, state, home, holdReviewBody: () => { holdReviewBody = true; }, origin: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); },
  };
}
