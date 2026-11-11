import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ASSETS } from "../lib/tracker/assets.mjs";
import { redact } from "../lib/execution_io.mjs";

function draftStorage({ supported = true } = {}) {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let now = 100, tail = Promise.resolve();
  const locks = { request: (_key, fn) => { const work = tail.then(fn); tail = work.catch(() => {}); return work; } };
  const drafts = new Function("localStorage", "Date", "redact", "globalThis", `${readFileSync(new URL("../templates/tracker/control-drafts.js", import.meta.url), "utf8")}\nreturn taskControlDrafts;`)(storage, { now: () => now }, redact, { navigator: supported ? { locks } : {} });
  const operation = id => ({ requestId: id, action: "message", note: "immutable", interrupt: false, previousId: "" });
  return { values, drafts, operation, locks, advance: () => { now += 8 * 24 * 60 * 60 * 1000; } };
}

test("bounded draft storage expires old drafts, isolates instances and retains unresolved identities", async () => {
  const { values, drafts, operation, advance } = draftStorage();
  const save = (instance, task) => drafts(instance, task).save({ value: "draft" });
  assert.equal(save("one", "task"), true);
  assert.equal(drafts("one", "task").initial.value, "draft");
  assert.equal(drafts("two", "task").initial.value, undefined);
  advance();
  assert.equal(drafts("one", "task").initial.value, undefined);
  for (let i = 0; i < 25; i++) assert.equal(save("one", `task-${i}`), true);
  assert.equal(JSON.parse(values.get("task-control-drafts-v1")).length, 20);
  assert.equal(drafts("one", "task-0").initial.value, undefined);
  for (let i = 0; i < 20; i++) await drafts("one", `pending-${i}`).claim(operation(`request-${i}`));
  await assert.rejects(drafts("one", "full").claim(operation("full")), /open tasks.*closed tasks/);
  advance();
  const retained = drafts("one", "pending-0");
  assert.equal(retained.initial.operation.requestId, "request-0");
  retained.save({ value: "", operation: null });
  assert.equal(drafts("one", "pending-0").initial.operation.note, "immutable", "discard cannot settle an identity");
  await retained.settle("another-id");
  assert.equal(retained.operation.requestId, "request-0", "only the same identity can settle");
  await retained.settle("request-0");
  await drafts("one", "room-again").claim(operation("room-again"));
  const sensitive = drafts("one", "room-again");
  assert.equal(sensitive.save({ value: "Bearer fixture-private-credential" }), false);
  assert.match(sensitive.error, /credential pattern/);
  await assert.rejects(drafts("one", "secret").claim({ ...operation("secret"), note: "Bearer fixture-private-credential" }));
  assert.equal([...values.values()].join("").includes("fixture-private-credential"), false);
  assert.equal(drafts("one", "room-again").initial.value, undefined);
});

test("stale tabs cannot erase or resurrect identities and concurrent claims keep one immutable request", async () => {
  const { drafts, operation } = draftStorage();
  const first = drafts("one", "task"), stale = drafts("one", "task");
  const [winner, loser] = await Promise.all([first.claim(operation("first")), stale.claim(operation("second"))]);
  assert.deepEqual(winner, loser);
  stale.save({ value: "a newer draft", operation: null });
  assert.equal(drafts("one", "task").initial.operation.requestId, "first");
  await first.acknowledge(winner);
  stale.save({ value: "", operation: winner });
  assert.equal(stale.operation.acknowledged, true);
  await first.settle("first");
  stale.save({ value: "keep draft", operation: winner });
  assert.equal(stale.operation, null, "a stale save cannot resurrect a settled request");
  await stale.claim(operation("next"));
  await first.settle("first");
  assert.equal(stale.operation.requestId, "next", "late settlement cannot erase a newer request");
});

test("stale draft checkpoints and acceptance preserve a competing edit", () => {
  const { drafts } = draftStorage();
  const first = drafts("one", "task"), second = drafts("one", "task");
  first.save({ value: "submitted" });
  second.save({ value: "newer competing draft" });
  first.save({ value: "submitted", pageY: 50 });
  assert.equal(drafts("one", "task").initial.value, "newer competing draft");
  first.save({ value: "" }, { ifValue: "submitted" });
  assert.equal(drafts("one", "task").initial.value, "newer competing draft");
  second.save({ value: "" });
  first.save({ value: "" });
  assert.equal(drafts("one", "task").initial.value, undefined);
});

test("unsupported cross-tab coordination refuses claims without persisting an identity", async () => {
  const { drafts, operation, values } = draftStorage({ supported: false });
  await assert.rejects(drafts("one", "task").claim(operation("blocked")), /Web Locks support/);
  assert.equal(values.has("task-control-requests-v1"), false);
});

test("legacy unresolved records migrate together and never reappear after settlement", async () => {
  const { values, drafts, operation } = draftStorage();
  values.set("task-control-drafts-v1", JSON.stringify(["first", "second"].map(task => ({
    key: JSON.stringify(["one", task]), updated: 100, value: "draft", operation: operation(task),
  }))));
  const first = drafts("one", "first"), stale = drafts("one", "first");
  stale.save({ value: "stale tab edit", operation: null });
  assert.equal(first.operation.requestId, "first");
  await first.settle("first");
  assert.equal(drafts("one", "second").operation.requestId, "second");
  stale.save({ value: "", operation: operation("first") });
  assert.equal(first.operation, null);
  assert.equal(JSON.parse(values.get("task-control-requests-v1")).length, 1);
});

test("review activity updates as text and reports connection failures without disturbing a draft", async () => {
  const lines=[{textContent:"source review: running; 1/2 jobs complete"}],timers=new Map();
  let nextTimer=0;
  const log={get firstElementChild(){return lines[0];},get childElementCount(){return lines.length;},appendChild(line){lines.push(line);}};
  const status={textContent:""},pane={dataset:{entry:"acme/widget/task"}};
  const elements={"review-activity":pane,"review-activity-log":log,"review-activity-state":status};
  const document={body:{dataset:{base:"/gallivant"}},getElementById:id=>elements[id]??null,createElement:()=>({textContent:""})};
  let ok=true;const fetch=async url=>{assert.match(url,/^\/gallivant\/api\/run\/review-activity\?/);if(!ok)throw new Error("offline");return {ok:true,json:async()=>({message:"<script>not markup</script>"})};};
  new Function("document","fetch","setTimeout","clearTimeout",ASSETS["/tracker.js"].body)(document,fetch,fn=>{timers.set(++nextTimer,fn);return nextTimer;},id=>timers.delete(id));
  await new Promise(setImmediate);
  assert.match(lines.at(-1).textContent,/<script>not markup<\/script>/);assert.match(status.textContent,/10 seconds/);
  ok=false;await timers.values().next().value();assert.match(status.textContent,/unavailable; retrying/);assert.equal(lines.length,2);
});

// Run the actual browser script; these elements only supply events, values and attributes.
function controls({ session = true, pending = false } = {}) {
  const el = props => ({ value: "", textContent: "", hidden: true, on: {}, focus() {},
    addEventListener(event, fn) { this.on[event] = fn; }, ...props });
  const buttons = ["recheck", "resume", "message", "cancel"].map(action => el({
    textContent: action, dataset: { action, available: String(!pending && (action === "recheck" || action === "cancel" || session)) },
  }));
  const last = el();
  const elements = {
    "run-controls": el({ dataset: { entry: "acme/widget/task", token: "local", pending: String(pending) }, querySelectorAll: () => buttons }),
    "run-note": el({ disabled: pending || !session }), "message-form": el(), "control-status": el(),
    "control-refresh": el({ href: "http://localhost/gallivant/run?id=acme%2Fwidget%2Ftask" }),
    "last-message": el({ querySelector: () => last }),
    "restore-message": el(), "interrupt-run": el({ checked: false }),
  };
  const document = { body: { dataset: { base: "/gallivant" } }, getElementById: id => elements[id] ?? null, activeElement: null };
  const requests = [], timers = new Map(), navigations = [], listeners = {}, storage = new Map();
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
    hide() { listeners.pagehide.forEach(fn => fn({ persisted: true })); },
    show() { listeners.pageshow.forEach(fn => fn({ persisted: true })); },
    get timerCount() { return timers.size; },
  };
  const fetch = async (url, options) => {
    if (!options?.method) {
      const requestId = new URL(url, "http://localhost").searchParams.get("requestId");
      const data = { controls: { recheck: true, resume: session, message: session, cancel: true, interrupt: session }, ...ui.result };
      return ui.readResponse ?? { ok: true, json: async () => ({ ...data,
        ...(requestId ? { requestId, request: { id: requestId, ...data.control } } : {}) }) };
    }
    const payload = JSON.parse(options.body);
    requests.push({ url, ...payload });
    const response = await ui.response;
    const data = await response.json();
    return { status: response.ok ? 202 : 409, ...response, json: async () => response.ok && !Object.keys(data).length
      ? { ...payload, id: payload.requestId, status: "queued" } : data };
  };
  new Function("document", "fetch", "setTimeout", "clearTimeout", "location", "globalThis", "localStorage", ASSETS["/tracker.js"].body)(
    document, fetch, f => { timers.set(++nextTimer, f); return nextTimer; }, id => timers.delete(id),
    { replace: url => navigations.push(url) }, { navigator: { locks: { request: async (_key, fn) => fn() } }, addEventListener: (event, fn) => { (listeners[event] ||= []).push(fn); } },
    { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  );
  return ui;
}

test("fixed actions never send or discard a draft, including after the daemon applies them", async () => {
  for (const action of ["recheck", "resume"]) {
    const ui = controls();
    ui.input("Keep this unsent draft.");
    await ui.click(action);
    assert.deepEqual(ui.requests, [{ url: "/gallivant/api/run/control?id=acme%2Fwidget%2Ftask", action, requestId: ui.requests[0].requestId }]);
    assert.match(ui.requests[0].requestId, /^[a-f0-9-]{36}$/);
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
    complete({ ok, json: async () => ok ? {} : { error: "Fixture rejection" } });
    await new Promise(setImmediate);
    assert.equal(ui.timerCount, 0, "no background polls while cached");
    ui.show();
    await new Promise(setImmediate);
    assert.equal(ui.requests.length, 1, "the original action is never resent");
    assert.equal(ui.elements["run-note"].value, "A newer unsent draft");
    assert.equal(ui.timerCount, 1, "exactly one status loop remains");
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
  assert.equal(ui.timerCount, 1, "only the resumed loop schedules a read");
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
  assert.deepEqual(ui.navigations, [], "settled requests never move the reading position");

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

test("settled polls refresh initially disabled controls and the composer without losing failed messages", async () => {
  const ui = controls({ pending: true });
  ui.result = { state: "needs-human", control: { action: "message", status: "applying" } };
  await ui.poll();
  assert.ok(ui.buttons.every(b => b.disabled));
  ui.result.control = { action: "message", status: "failed", note: "Retry this saved message." };
  await ui.poll();
  assert.ok(ui.buttons.every(b => !b.disabled));
  assert.equal(ui.elements["run-note"].disabled, false);
  assert.equal(ui.elements["run-note"].value, "Retry this saved message.");
  assert.deepEqual(ui.navigations, []);
  ui.input("Edited message");
  await ui.click("message");
  assert.equal(ui.requests[0].note, "Edited message");
});

test("settled polls cannot enable controls from missing or unresolved ownership observations", async () => {
  for (const available of [null, { recheck: true, cancel: true, resume: false, message: false, interrupt: false }]) {
    const ui = controls({ pending: true });
    ui.elements["interrupt-run"].checked = true;
    ui.result = { state: "needs-human", controls: available, control: { action: "message", status: "failed", note: "Preserved draft" } };
    await ui.poll();
    assert.equal(ui.buttons[1].disabled, true);
    assert.equal(ui.buttons[2].disabled, true);
    assert.equal(ui.elements["run-note"].disabled, true);
    assert.equal(ui.elements["interrupt-run"].disabled, true);
    assert.equal(ui.elements["interrupt-run"].checked, false);
    assert.equal(ui.elements["run-note"].value, "Preserved draft");
    assert.deepEqual(ui.navigations, []);
  }
});
