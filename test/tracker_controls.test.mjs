import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS } from "../lib/tracker/assets.mjs";

test("review activity updates as text and reports connection failures without disturbing a draft", async () => {
  const lines=[{textContent:"source review: running; 1/2 jobs complete"}],timers=[];
  const log={get firstElementChild(){return lines[0];},get childElementCount(){return lines.length;},appendChild(line){lines.push(line);}};
  const status={textContent:""},pane={dataset:{entry:"acme/widget/task"}};
  const elements={"review-activity":pane,"review-activity-log":log,"review-activity-state":status};
  const document={body:{dataset:{base:"/gallivant"}},getElementById:id=>elements[id]??null,createElement:()=>({textContent:""})};
  let ok=true;const fetch=async url=>{assert.match(url,/^\/gallivant\/api\/run\/review-activity\?/);if(!ok)throw new Error("offline");return {ok:true,json:async()=>({message:"<script>not markup</script>"})};};
  new Function("document","fetch","setTimeout",ASSETS["/tracker.js"].body)(document,fetch,fn=>timers.push(fn));
  await new Promise(setImmediate);
  assert.match(lines.at(-1).textContent,/<script>not markup<\/script>/);assert.match(status.textContent,/10 seconds/);
  ok=false;await timers.shift()();assert.match(status.textContent,/unavailable; retrying/);assert.equal(lines.length,2);
});

// Run the actual browser script; these elements only supply events, values and attributes.
function controls({ session = true, pending = false } = {}) {
  const el = props => ({ value: "", textContent: "", hidden: true, on: {}, focus() {},
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
    "restore-message": el(), "interrupt-run": el({ checked: false }),
  };
  const document = { body: { dataset: { base: "/gallivant" } }, getElementById: id => elements[id] ?? null, activeElement: null };
  const requests = [], timers = new Map(), navigations = [], listeners = {};
  let nextTimer = 0;
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
    async poll() { assert.ok(timers.size); const [id, work] = timers.entries().next().value; timers.delete(id); await work(); },
    hide() { listeners.pagehide({ persisted: true }); },
    show() { listeners.pageshow({ persisted: true }); },
    get timerCount() { return timers.size; },
  };
  const fetch = async (url, options) => {
    if (!options?.method) return ui.readResponse ?? { ok: true, json: async () => ui.result };
    requests.push({ url, ...JSON.parse(options.body) });
    return ui.response;
  };
  new Function("document", "fetch", "setTimeout", "clearTimeout", "location", "globalThis", ASSETS["/tracker.js"].body)(
    document, fetch, f => { timers.set(++nextTimer, f); return nextTimer; }, id => timers.delete(id),
    { replace: url => navigations.push(url) }, { addEventListener: (event, fn) => { listeners[event] = fn; } },
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

test("cached controls settle the original POST on return without replaying it or losing newer drafts", async () => {
  for (const ok of [true, false]) {
    const ui = controls();
    ui.input("The submitted draft");
    let complete;
    ui.response = new Promise(resolve => { complete = resolve; });
    await ui.click("message");
    ui.input("A newer unsent draft");
    ui.hide();
    complete({ ok, json: async () => ({ error: "Fixture rejection" }) });
    await new Promise(setImmediate);
    assert.equal(ui.timerCount, 0, "no background polls while cached");
    ui.show();
    await new Promise(setImmediate);
    assert.equal(ui.requests.length, 1, "the original action is never resent");
    assert.equal(ui.elements["run-note"].value, "A newer unsent draft");
    assert.equal(ui.timerCount, ok ? 1 : 0, "only an accepted action starts polling");
    if (!ok) assert.match(ui.elements["control-status"].textContent, /Fixture rejection/);
    else assert.equal(ui.last.textContent, "The submitted draft");
  }
});

test("a pre-cache control read cannot overwrite its resumed poll or start another timer", async () => {
  const ui = controls({ pending: true });
  ui.input("Keep the draft");
  let complete;
  ui.readResponse = { ok: true, json: () => new Promise(resolve => { complete = resolve; }) };
  const oldPoll = ui.poll();
  await new Promise(setImmediate);
  ui.hide();
  ui.readResponse = null;
  ui.show();
  await new Promise(setImmediate);
  const restored = ui.elements["control-status"].textContent;
  complete({ control: { status: "queued", action: "message" } });
  await oldPoll;
  assert.equal(ui.elements["control-status"].textContent, restored);
  assert.equal(ui.timerCount, 0);
  assert.equal(ui.elements["run-note"].value, "Keep the draft");
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


test("interrupt is explicit and failed messages can be edited and resent", async () => {
  const ui = controls();
  ui.input("Preserve all article sections.");
  ui.elements["interrupt-run"].checked = true;
  await ui.click("message");
  assert.equal(ui.requests[0].interrupt, true);
  ui.result = { state: "needs-human", control: { action: "message", status: "failed", note: "Preserve all article sections.", message: "Review the changed brief." } };
  await ui.poll();
  assert.equal(ui.elements["run-note"].value, "Preserve all article sections.");
  assert.deepEqual(ui.navigations, []);
  ui.input("");
  ui.elements["restore-message"].on.click();
  assert.equal(ui.elements["run-note"].value, "Preserve all article sections.");
  ui.input("New draft");
  ui.elements["restore-message"].on.click();
  assert.equal(ui.elements["run-note"].value, "New draft");
});
