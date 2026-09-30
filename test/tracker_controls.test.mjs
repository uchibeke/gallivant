import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS } from "../lib/tracker/assets.mjs";

// Run the actual browser script; these elements only supply events, values and attributes.
function controls({ session = true, pending = false } = {}) {
  const el = props => ({ value: "", textContent: "", hidden: true, on: {},
    addEventListener(event, fn) { this.on[event] = fn; }, ...props });
  const buttons = ["recheck", "resume", "message"].map(action => el({
    textContent: action, dataset: { action, available: String(action === "recheck" || session) },
  }));
  const last = el();
  const elements = {
    "run-controls": el({ dataset: { entry: "acme/widget/task", token: "local", pending: String(pending) }, querySelectorAll: () => buttons }),
    "run-note": el(), "message-form": el(), "control-status": el(),
    "control-refresh": el({ href: "http://localhost/gallivant/run?id=acme%2Fwidget%2Ftask" }),
    "last-message": el({ querySelector: () => last }),
  };
  const document = { body: { dataset: { base: "/gallivant" } }, getElementById: id => elements[id] ?? null, activeElement: null };
  const requests = [], timers = [], navigations = [];
  const ui = {
    buttons, elements, last, document, requests, navigations,
    response: { ok: true, json: async () => ({}) },
    result: { state: "needs-human", control: { action: "recheck", status: "applied", message: "Watching again." } },
    input(value) { elements["run-note"].value = value; elements["run-note"].on.input(); },
    async click(action) {
      if (action === "message") elements["message-form"].on.submit({ preventDefault() {} });
      else await buttons.find(b => b.dataset.action === action).on.click();
      await new Promise(setImmediate);
    },
    async poll() { assert.ok(timers.length); await timers.shift()(); },
  };
  const fetch = async (url, options) => {
    if (!options) return { ok: true, json: async () => ui.result };
    requests.push({ url, ...JSON.parse(options.body) });
    return ui.response;
  };
  new Function("document", "fetch", "setTimeout", "location", ASSETS["/tracker.js"].body)(
    document, fetch, f => timers.push(f), { replace: url => navigations.push(url) },
  );
  return ui;
}

test("fixed actions never send or discard a draft, including after the daemon applies them", async () => {
  for (const action of ["recheck", "resume"]) {
    const ui = controls();
    ui.input("Keep this unsent draft.");
    await ui.click(action);
    assert.deepEqual(ui.requests, [{ url: "/gallivant/api/run/control?id=acme%2Fwidget%2Ftask", action }]);
    assert.ok(ui.buttons.every(b => b.disabled), "one pending request at a time");
    assert.equal(ui.elements["run-note"].value, "Keep this unsent draft.");
    await ui.poll();
    assert.deepEqual(ui.navigations, [], "completion must not reload over a draft");
    assert.equal(ui.elements["run-note"].value, "Keep this unsent draft.");
    assert.equal(ui.elements["control-refresh"].hidden, false);
    assert.ok(ui.buttons.every(b => !b.disabled));
  }
});

test("only sending delivers text; rejection preserves it and acceptance preserves newer edits", async () => {
  const ui = controls();
  await ui.click("message");
  assert.equal(ui.requests.length, 0, "empty messages cannot submit");
  ui.input("Please check the fixture.");
  ui.response = { ok: false, json: async () => ({ error: "Request already pending." }) };
  await ui.click("message");
  assert.equal(ui.elements["run-note"].value, "Please check the fixture.");
  assert.match(ui.elements["control-status"].textContent, /Request already pending/);
  assert.equal(ui.buttons[2].disabled, false);

  let accept;
  ui.response = new Promise(resolve => { accept = resolve; });
  await ui.click("message");
  ui.input("A newer draft written during the request.");
  accept({ ok: true, json: async () => ({}) });
  await new Promise(setImmediate);
  assert.equal(ui.requests.at(-1).action, "message");
  assert.equal(ui.requests.at(-1).note, "Please check the fixture.");
  assert.equal(ui.last.textContent, "Please check the fixture.");
  assert.equal(ui.elements["run-note"].value, "A newer draft written during the request.");
  ui.result = { state: "needs-human", control: { action: "message", status: "failed", message: "Inspect the log." } };
  await ui.poll();
  assert.deepEqual(ui.navigations, []);
  assert.equal(ui.elements["run-note"].value, "A newer draft written during the request.");
  ui.response = { ok: true, json: async () => ({}) };
  await ui.click("message");
  assert.equal(ui.elements["run-note"].value, "", "only the accepted draft clears");
});

test("pending requests restore safely; no-session and closed tasks keep agent actions disabled", async () => {
  const ui = controls({ session: false, pending: true });
  assert.ok(ui.buttons.every(b => b.disabled));
  await ui.poll();
  assert.equal(ui.buttons[0].disabled, false);
  assert.equal(ui.buttons[1].disabled, true);
  ui.input("Message without a session");
  assert.equal(ui.buttons[2].disabled, true);
  assert.deepEqual(ui.navigations, [ui.elements["control-refresh"].href]);

  const closed = controls({ pending: true });
  closed.input("An unsent draft");
  closed.result.state = "done";
  await closed.poll();
  assert.ok(closed.buttons.every(b => b.disabled));
  assert.equal(closed.elements["run-note"].value, "An unsent draft");
});
