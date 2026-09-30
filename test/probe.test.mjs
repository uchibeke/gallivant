import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkHarness, probeAll, probeFix, allOk } from "../lib/probe.mjs";
import { up } from "../lib/commands/up.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { CONFIG, T0, tempHome, harnessBin, fakeGh, fakeNotify, silentLog } from "./helpers.mjs";

test("harness readiness requires a supported, readable version before checking login", async () => {
  for (const options of [{ version: "0.155.1" }, { version: "unrecognised" }, { versionExit: 1 }]) {
    const home = tempHome();
    const config = { harness: { codex: { bin: harnessBin(home, "codex", options) } } };
    const result = await checkHarness("codex", config);
    assert.equal(result.ok, false);
    assert.match(probeFix("codex", result), /install codex 0\.158\.0 or newer/);
    assert.doesNotMatch(probeFix("codex", result), /codex login/);
    assert.deepEqual(readFileSync(join(home, "codex-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [["--version"]]);
  }
});

test("supported harnesses pass only when signed in, and authentication failures keep the login remedy", async () => {
  for (const signedIn of [true, false]) {
    const home = tempHome();
    const config = { harness: { codex: { bin: harnessBin(home, "codex", { signedIn }) } } };
    const probes = await probeAll({ config, gh: fakeGh() });
    assert.equal(allOk(probes), signedIn);
    assert.equal(probes.codex.ok, signedIn);
    if (!signedIn) assert.equal(probeFix("codex", probes.codex), "codex login");
    assert.deepEqual(readFileSync(join(home, "codex-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [["--version"], ["login", "status"]]);
  }
});

test("daemon rejects old Codex before entering a dispatch tick and records an actionable failed probe", async () => {
  const home = tempHome();
  const state = makeState(home);
  state.put("acme/widget/probe", newEntry({ repo: "acme/widget", pr: 1, branch: "gallivant/probe", worktree: "/tmp/unused-probe", harness: "codex", state: STATES.prOpen, nowIso: T0 }));
  const before = state.entries();
  let runsRead = 0;
  const notify = fakeNotify();
  await up({
    home, state, config: { ...CONFIG, repos: [], harness: { codex: { bin: harnessBin(home, "codex", { version: "0.155.1" }) } } },
    gh: fakeGh(), log: silentLog, notify,
    runnerFor: () => { runsRead++; throw new Error("dispatch must not be reached"); },
  }, { once: true });
  const health = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
  assert.equal(health.probes.codex.ok, false);
  assert.match(health.probes.codex.detail, /0\.155\.1 is older than 0\.158\.0/);
  assert.match(health.probes.codex.fix, /install codex/);
  assert.equal(runsRead, 0);
  assert.deepEqual(state.entries(), before);
  assert.ok(notify.sent.some(n => JSON.stringify(n).includes("install codex")));
});
