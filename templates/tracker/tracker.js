// The tracker's one script, served as a file so the CSP is `script-src 'self'` with no nonce and no hash, and so
// nothing here needs an inline event handler.
//
// Two jobs: the sidebar (filter, collapse, persist) and the log pane (stream, auto-scroll). Both are wired from
// data attributes the server rendered, so this file knows no ids or paths of its own.
//
// lib/harness_log.mjs is spliced in ahead of this file by lib/tracker/assets.mjs, so `harnessLine` is in scope here
// and strict mode is declared there, at the top of the served script where a directive counts.

// Where this tracker is mounted: empty when it owns the origin, something like "/gallivant" when a host server
// delegates a prefix to it. The server publishes it on <body data-base> because this file is served from one route
// and cannot be told at build time where it lives.
const BASE = document.body.dataset.base || "";

// Fixed actions and messages share delivery, but only Send message reads the composer's draft.
const runControls = document.getElementById("run-controls");
if (runControls) {
  const buttons = [...runControls.querySelectorAll("button[data-action]")];
  const note = document.getElementById("run-note");
  const form = document.getElementById("message-form");
  const status = document.getElementById("control-status");
  const refresh = document.getElementById("control-refresh");
  const lastMessage = document.getElementById("last-message");
  const endpoint = `${BASE}/api/run/control?id=${encodeURIComponent(runControls.dataset.entry)}`;
  let pending = runControls.dataset.pending === "true";
  let closed = false;
  const syncButtons = () => buttons.forEach(button => {
    button.disabled = pending || closed || button.dataset.available !== "true"
      || (button.dataset.action === "message" && !note.value.trim());
  });
  const label = action => buttons.find(b => b.dataset.action === action)?.textContent || "Request";
  const poll = async () => {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error("Could not check the request. Reload to see its status.");
      const data = await response.json();
      const control = data.control;
      if (!control) throw new Error("Request status is unavailable. Reload before retrying.");
      status.textContent = `${label(control.action)} — ${control.status}: ${control.message || "Waiting for the daemon and any active run."}`;
      if (control.status === "queued" || control.status === "applying") { setTimeout(poll, 3000); return; }
      pending = false;
      closed = data.state === "done";
      syncButtons();
      // Follow the newest run unless that would discard a draft or interrupt typing.
      if (!note.value && document.activeElement !== note) { location.replace(refresh.href); return; }
      refresh.hidden = false;
    } catch (e) { status.textContent = e.message; setTimeout(poll, 5000); }
  };
  const submit = async action => {
    const button = buttons.find(b => b.dataset.action === action);
    if (!button || button.disabled) return;
    const draft = action === "message" ? note.value : "";
    pending = true; syncButtons(); refresh.hidden = true;
    status.textContent = `${label(action)} — queuing…`;
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Gallivant-Token": runControls.dataset.token },
        body: JSON.stringify(action === "message" ? { action, note: draft } : { action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed. Reload to check its status before retrying.");
      if (action === "message") {
        // A user can keep composing while delivery is pending. Never erase newer edits.
        if (note.value === draft) note.value = "";
        lastMessage.querySelector("pre").textContent = draft;
        lastMessage.hidden = false;
      }
      status.textContent = `${label(action)} — queued. Waiting for the daemon and any active run.`;
      setTimeout(poll, 1000);
    } catch (e) {
      status.textContent = `${label(action)} — ${e.message}`;
      pending = false; syncButtons();
    }
  };
  for (const button of buttons.filter(b => b.dataset.action !== "message")) {
    button.addEventListener("click", () => submit(button.dataset.action));
  }
  form.addEventListener("submit", event => { event.preventDefault(); submit("message"); });
  note.addEventListener("input", syncButtons);
  syncButtons();
  if (pending) setTimeout(poll, 1000);
}

// localStorage can throw, not only return null: a private window, a browser set to block site data, or a frame whose
// storage the embedder partitioned away. Every read and write is guarded and the page works with no stored value.
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* the page works without it */ } },
};

// ---- sidebar --------------------------------------------------------------------
// Groups collapse, a filter searches every row's text, and collapsed state survives a reload. The one detail that
// makes a filter feel right, taken from command-center's explorer: while a filter is active, collapsed state is
// ignored and every match shows expanded. Otherwise a match hidden inside a closed group reads as "no results".
const side = document.getElementById("side");
if (side) {
  const key = "gallivant.tracker.collapsed:" + (side.dataset.view || "default");
  const closed = () => LS.get(key, {});
  const groups = [...side.querySelectorAll(".group")];
  const q = document.getElementById("filter");
  const count = document.getElementById("matches");

  const render = () => {
    const term = (q?.value || "").trim().toLowerCase();
    const shut = term ? {} : closed();          // a filter ignores collapsed state, so every match is visible
    let shown = 0;
    for (const g of groups) {
      const rows = [...g.querySelectorAll("a.row")];
      let hits = 0;
      for (const row of rows) {
        // The row's own text is what is searched: its handle, its detail and its badge, whatever the server put
        // there. `hay` is filled in by the server so a filter matches fields the row does not display in full.
        const hay = ((row.dataset.hay || "") + " " + row.textContent).toLowerCase();
        const hit = !term || hay.includes(term);
        row.hidden = !hit;
        if (hit) hits++;
      }
      g.hidden = rows.length > 0 && hits === 0;
      g.classList.toggle("closed", !!shut[g.dataset.group]);
      const tally = g.querySelector("h3 small");
      if (tally) tally.textContent = term ? hits + "/" + rows.length : String(rows.length);
      shown += hits;
    }
    if (count) count.textContent = term ? shown + (shown === 1 ? " match" : " matches") : "";
  };

  for (const g of groups) {
    const head = g.querySelector("h3");
    if (!head) continue;
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const toggle = () => {
      // A toggle while a filter is active would be invisible (the filter overrides collapse), so it only records
      // the intent for when the filter is cleared.
      const c = closed();
      if (c[g.dataset.group]) delete c[g.dataset.group]; else c[g.dataset.group] = true;
      LS.set(key, c);
      render();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  }
  q?.addEventListener("input", render);
  // Escape clears the filter, which is what every filter box does and costs one line.
  q?.addEventListener("keydown", e => { if (e.key === "Escape") { q.value = ""; render(); } });
  render();
}

// ---- grouping switch ------------------------------------------------------------
// Two groupings, so this is a navigation, not a state machine: the server renders the grouping the URL asks for and
// the page reloads into it. Nothing to keep in sync, and a grouped view is a link somebody can bookmark or frame.
const by = document.getElementById("groupby");
if (by) by.addEventListener("change", () => {
  const u = new URL(location.href);
  u.searchParams.set("by", by.value);
  location.assign(u.pathname + "?" + u.searchParams.toString());     // same document, never the top-level window
});

// ---- log pane -------------------------------------------------------------------
const pane = document.getElementById("log"), state = document.getElementById("logstate");
// The most LIVE rows the pane keeps. Beyond this the oldest live rows are dropped; the complete log is on disk and the
// "load earlier" control fetches any of it back.
//
// History the reader loaded is exempt from this, which is the decision worth saying out loud. The cap exists to bound
// a DOM that an unbounded live stream would otherwise grow forever: nobody asked for the ten-thousandth line of a
// running build, and dropping it costs the reader nothing because it is still on disk. History is the opposite case.
// The reader pressed a button for it, and there is nothing to fetch it back from once it is gone but the same button
// they just pressed, so trimming it would silently undo the click and the feature would read as broken. Raising the
// cap for everyone instead would put the DOM cost of a long history onto every pane whether or not it asked. So the
// budget grows by exactly what was loaded, and only the live tail is ever trimmed.
const MAX_LINES = 2000;
if (pane) {
  // Auto-scroll follows the reader: the pane jumps to the bottom only when it was already at the bottom, so
  // scrolling up to read something does not yank you back down on the next line.
  const atBottom = () => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  // Lines arrive in bursts: a reconnect delivers hundreds at once, and a busy harness writes faster than the screen
  // refreshes. Appending per line stalled the main thread badly enough that the browser dropped the stream and
  // retried, which replayed the burst, which stalled it again. Buffer and paint once per frame instead.
  let pending = [], painting = false, closed = false;
  // Reaching back: `oldest` is the id of the oldest line the pane holds (what the history route takes as
  // `?before=`), `loaded` is how many rows the reader explicitly loaded, which the cap exempts, and `busy`
  // keeps two presses of the button from fetching the same window twice. Declared with the rest of the pane's
  // state because `trim` reads `loaded` and runs from `paint`.
  let oldest = null, loaded = 0, busy = false;
  // Which harness wrote this log, so the right stream reader is used on each line. The server knows it from the
  // registry and publishes it on the pane; an unknown or absent value means every line renders as itself.
  const harness = pane.dataset.harness || "";
  /**
   * Drop the oldest LIVE rows past the cap, leaving loaded history alone.
   *
   * Two decisions here, and the second is the one that took a rewrite.
   *
   * The budget is MAX_LINES plus whatever the reader explicitly loaded. Raising MAX_LINES for everyone would put the
   * DOM cost of a long history onto every pane whether or not it asked, and leaving the budget alone would mean the
   * next burst of live output silently undoes the click.
   *
   * And the trim comes off the row after the history block, not off the top. Trimming from the top looks right and is
   * wrong: history sits above the live tail, so the top IS the history, and a growing budget that still trims from the
   * top just delays eating the thing it was meant to protect. Dropping the oldest live rows instead keeps both ends
   * the reader cares about, which is the history they asked for and the output arriving now.
   *
   * `loaded` is the count of history rows at the front of the pane, so it is also the index the trim starts at.
   */
  const trim = () => {
    while (pane.childElementCount > MAX_LINES + loaded) {
      const victim = pane.children[loaded];
      // Only when the pane holds nothing but history, which the budget makes impossible: it always leaves MAX_LINES of
      // room above `loaded`. Belt and braces, because an unbounded loop here would hang the tab.
      if (!victim) return;
      victim.remove();
    }
  };

  /**
   * A heartbeat, applied to the row its call already has.
   *
   * Claude Code sends one every 30 seconds for a tool that has not returned. Twenty-one of them arrived in the run
   * this was built against and twenty-one rows would have been noise, so the row counts up instead: the `Bash` line
   * the reader is already looking at gains "running 4m 30s" and keeps it current. Returns whether the row was found;
   * a heartbeat for a row that is gone falls through to a row of its own, since a call alive for four minutes with
   * nothing on screen is the complaint this answers.
   */
  const beat = p => {
    if (!p.of) return false;
    // The id is read off the DOM and compared, never spliced into a selector: it comes out of a log file, so a
    // querySelector built by concatenation would be a selector injection waiting for the right bytes.
    let row = null;
    for (const el of pane.querySelectorAll("div.ll.t[data-id]")) if (el.dataset.id === p.of) row = el;
    if (!row) return false;
    let e = row.querySelector("span.e");
    if (!e) {
      e = document.createElement("span");
      e.className = "e";
      // Inside the argument cell, not beside it. `.ll.t` is a two-column grid, so a third child of the row would
      // start a second grid row and the timer would land under the command instead of after it.
      (row.querySelector("span.a") || row).append(e);
    }
    // textContent, never innerHTML: the only characters this writes are ones `elapsed` made out of a number.
    e.textContent = elapsed(p.secs);
    return true;
  };
  const paint = () => {
    painting = false;
    if (closed || !pending.length) return;
    const stick = atBottom();
    // Markup goes in first, heartbeats are applied second. That order matters: a burst can carry the call and its
    // first heartbeat together, and applying the beat before the row existed would have drawn a duplicate row.
    //
    // The markup is appended to the pane itself rather than inside a wrapper div. The cap below counts the pane's
    // children, and a wrapper per frame made one paint of three hundred lines count as a single child, so the cap
    // never fired and the DOM grew without bound on a long run.
    const rows = pending.flatMap(line => renderRows(line, { harness }));
    pending = [];
    const html = rows.filter(r => r.kind !== "beat").map(r => renderParsed(r, { harness })).join("");
    if (html) { const t = document.createElement("template"); t.innerHTML = html; pane.append(t.content); }
    // A heartbeat whose row is not on the pane (trimmed by the cap, or the pane opened after the call started) still
    // deserves to be said: a Bash step alive for four minutes with nothing on screen is the complaint this answers.
    const orphans = rows.filter(r => r.kind === "beat" && !beat(r));
    if (orphans.length) {
      const t = document.createElement("template");
      t.innerHTML = orphans.map(r => renderParsed(r, { harness })).join("");
      pane.append(t.content);
    }
    if (stick) pane.scrollTop = pane.scrollHeight;
    // A very long pane costs memory and scroll performance for lines nobody scrolls back to. The whole log is on
    // disk, and the "load earlier" control above can fetch any of it back, so dropping the oldest rows loses nothing.
    trim();
  };
  const push = line => { pending.push(line); if (!painting) { painting = true; requestAnimationFrame(paint); } };
  const note = (text, cls) => { const el = document.createElement("div"); el.className = "ll " + cls; el.textContent = text; pane.append(el); };
  // A run from another tool has no registry entry and is addressed by its source label instead; one of Gallivant's
  // own is addressed by entry. The server validates whichever arrives.
  const q = new URLSearchParams({ run: pane.dataset.run });
  if (pane.dataset.source) q.set("source", pane.dataset.source); else q.set("id", pane.dataset.entry);
  const url = BASE + "/api/run/output?" + q.toString();

  // ---- reaching back ------------------------------------------------------------
  // `oldest` is the id of the oldest line the pane holds, which is what the history route wants as `?before=`. The
  // stream's `skipped` frame is the count of lines it did not send, so the first line the pane holds is that count
  // plus one, and the window before it is the one the reader gets first.
  const earlier = document.getElementById("earlier"), earlierState = document.getElementById("earlierstate");
  const tell = text => { if (earlierState) earlierState.textContent = text; };
  const offer = n => {
    if (!earlier) return;
    earlier.hidden = n <= 0;
    earlier.disabled = n <= 0 || busy;
    if (n > 0) tell(n + (n === 1 ? " earlier line" : " earlier lines") + " not shown yet");
  };
  /**
   * Fetch the window before what the pane holds and prepend it, without moving what the reader is looking at.
   *
   * Prepending to a scrolled container is what makes this kind of control feel broken: the browser keeps scrollTop,
   * which is measured from the top, so inserting content above it slides everything the reader was reading downward
   * out of view. The fix is to measure the height before and after and add the difference back to scrollTop, which
   * leaves the same pixels under the same line of the reader's eye. scrollHeight is read after the insert and before
   * anything else touches the pane, because a later reflow would make the difference wrong.
   */
  const loadEarlier = async () => {
    if (busy || oldest === null || oldest <= 1) return;
    busy = true;
    if (earlier) earlier.disabled = true;
    tell("loading");
    try {
      const h = new URLSearchParams(q);
      h.set("before", String(oldest));
      const r = await fetch(BASE + "/api/run/history?" + h.toString(), { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("history " + r.status);
      const got = await r.json();
      const lines = Array.isArray(got.lines) ? got.lines : [];
      const html = lines.flatMap(line => renderRows(line, { harness })).map(row => renderParsed(row, { harness })).join("");
      const before = pane.scrollHeight, top = pane.scrollTop;
      if (html) {
        const t = document.createElement("template");
        t.innerHTML = html;
        // How many rows this actually added, counted from the template rather than from `lines`: one event can be
        // several rows and a clean tool result is none, so the line count is not the row count and the cap needs the
        // row count.
        loaded += t.content.childElementCount;
        pane.prepend(t.content);
      }
      pane.scrollTop = top + (pane.scrollHeight - before);
      oldest = got.from ?? oldest;
      offer(got.before ?? 0);
      if ((got.before ?? 0) <= 0) tell("this is the first line of the run");
    } catch {
      // The pane is the only place a reader sees this, so it says what happened rather than going quiet. The button
      // stays available: a failed fetch is worth retrying and nothing was consumed.
      tell("could not load earlier lines");
    } finally {
      busy = false;
      if (earlier) earlier.disabled = oldest === null || oldest <= 1;
    }
  };
  earlier?.addEventListener("click", loadEarlier);

  const es = new EventSource(url);
  const say = text => { if (state) state.textContent = text; };
  es.addEventListener("skipped", e => {
    const n = Number(e.data);
    if (!Number.isFinite(n) || n <= 0) return;
    note(n + ' earlier lines not shown; "load earlier lines" above fetches them, and the whole log is in the run folder', "skip");
    // The tail starts at line n+1, so the oldest line the pane holds is n+1 and the window before it starts at n.
    oldest = n + 1;
    offer(n);
  });
  es.onmessage = e => {
    const text = JSON.parse(e.data);
    // A terminal frame is the one thing the stream sends that is not a log line, and it is where the pane stops
    // reconnecting. Every one of them is bracketed and nothing else the server sends is.
    if (/^\[(exit|no run|ended)\b/.test(text)) {
      // Once, however many times it arrives. A reconnect resumes from Last-Event-ID and the server re-sends the
      // terminal frame for a run that is already over, so a pane that had reconnected printed the closing line
      // twice. `closed` is the record that the end was already drawn, and it is checked before anything is drawn.
      if (closed) return;
      paint();
      closed = true;
      es.close();
      note(text.slice(1, -1), "d " + (text === "[exit 0]" ? "ok" : "bad"));
      say(text === "[no run]" ? "no run on disk" : text === "[exit 0]" ? "finished" : text.slice(1, -1));
      return;
    }
    push(text);
  };
  es.onopen = () => say("live");
  // readyState 2 is closed, which is the normal end of a finished run and not a failure to report.
  es.onerror = () => { if (es.readyState !== 2) say("reconnecting"); };
}

// ---- log lines ------------------------------------------------------------------
// The renderer is command-center's public/logline.js, unchanged apart from the escaper, which is inlined here
// because Gallivant has no md.js. Two copies that drift are how the five log panels it replaced went wrong in the
// first place, so a fix to the regexes belongs in both.
//
// What differs is the input, and only the input. Command-center's harness reducer hands the panel an indented
// "Tool: argument" line; Gallivant's runs write the harness's own stream-json straight to job.log, so a line here is
// an event object. `harnessLine` (lib/harness_log.mjs, spliced in above) turns one of those into the same
// { kind, tool, arg } this renderer already took, and every regex below is then the fallback for a line that is not
// an event of a shape the harness's reader claims. Parser per harness, one renderer.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));


// Tool calls arrive indented by the harness reducer in lib/harness.mjs: "  WebSearch: quiet hotels in Lisbon".
const TOOL = /^ {2}([A-Za-z_][\w.]*):\s?(.*)$/;
// A terminal line the runner appends: "done in 42s (harness exit 0)" or "failed after 271s: ...".
const DONE = /^(done in |wrote |failed after )/;
// The runner's own opening line, written by lib/harness_run.mjs before the harness says anything.
const HEAD = /^harness \S+.*prompt \d+ chars/;
// Bare URLs. Stops before trailing punctuation so a sentence-final period is not swallowed into the link.
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;
// A project-relative path with an extension: ideas/2026-09-25-trip.md, gtm/posts/one.md.
const PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b/g;

/** Which tools are worth colouring apart. Everything else is a neutral tool call. */
const TOOL_KIND = {
  WebSearch: "search", WebFetch: "fetch", Read: "read", Write: "write", Edit: "write",
  Bash: "shell", Agent: "agent", Task: "agent", ToolSearch: "meta", ListAgents: "meta",
  SendMessage: "meta", Monitor: "meta", Glob: "read", Grep: "read",
};

/**
 * Classify one line.
 *   { kind: "tool", tool, arg }   a tool call
 *   { kind: "deny", tool, arg }   a guardrail hook that blocked one
 *   { kind: "done", text, ok }    the run's own closing line
 *   { kind: "text", text }        anything else the model said
 */
function parseLine(line, { harness } = {}) {
  const raw = String(line);
  // The harness's own stream first. It answers for every line it recognises; anything else falls through to the
  // prose rules below, which is what keeps a runner line, a stderr spill or a crash message readable.
  const ev = harness ? harnessLine(harness, raw) : null;
  if (ev) return ev;
  const m = TOOL.exec(raw);
  if (m) return { kind: "tool", tool: m[1], arg: m[2].trim(), tone: TOOL_KIND[m[1]] || "" };
  const t = raw.trim();
  if (HEAD.test(t)) return { kind: "head", text: t };
  if (DONE.test(t)) return { kind: "done", text: t, ok: !t.startsWith("failed") };
  // Nothing here claimed it, so it is not prose the model wrote and it must not be read as prose.
  //
  // This is the case the real defect was in. A harness's own stderr fell through to `{ kind: "text" }`, and a prose
  // row runs the markdown pass, which is correct for a model's paragraph and wrong for a message nobody wrote as
  // markdown. `Error: --add-dir *cannot* be used with __proto__` came out as `Error: --add-dir <i>cannot</i> be used
  // with <b>proto</b>`: the asterisks and the underscores were taken as emphasis and DELETED, so the identifier the
  // reader needed was not on the page at all. On the run this was read off, the only line that said why the run
  // failed (`Error: Input must be provided either through stdin or as a prompt argument when using --print`) was the
  // most important line in the log and was being handed to a formatter that could eat parts of it.
  //
  // `raw` is the answer: the line as itself, escaped, with URLs still linked because a URL in a crash message is
  // worth clicking, and with no other pass over it. So every character the harness printed is on screen.
  return { kind: "raw", text: t };
}

/**
 * The markdown a model actually writes into a log line, and nothing else.
 *
 * No library, for the reason this whole file has none: the subset that shows up in a harness's prose is inline code,
 * bold, italic and a link, and the block level is a heading or a list item, which the reader has already split onto
 * its own row. That is five regexes. A markdown library is tens of kilobytes and its job is the ninety percent of
 * CommonMark (tables, reference links, HTML passthrough, nested blockquotes) that never appears here, and the
 * passthrough part is the one thing this must not have: the input is agent output.
 *
 * Order matters. Inline code is taken out FIRST and put back last, so a `*` or an `_` inside a code span is not read
 * as emphasis, which is the bug every naive markdown regex has. And every one of these runs on already-escaped text,
 * so `<b>` in the log stays the characters `&lt;b&gt;` and the only `<b>` on the page is one this function wrote.
 */
function md(html, done) {
  // Inline code first, parked behind a placeholder that cannot occur in escaped text (it holds no & < > " and the
  // backtick pairs are gone by the time anything else looks at the string).
  const code = [];
  let out = html.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  // Bold before italic, so ** is not read as two separate * runs.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>");
  // Italic only on a `*` that is not part of a `**` and not a bare bullet, and on `_` only between word characters,
  // so a snake_case identifier in prose is not turned into emphasis.
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<i>$2</i>")
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<i>$2</i>");
  // A markdown link. The href is checked against http(s) before it is written: a javascript: or data: target is left
  // as the text it was, because this function's whole safety property is that it writes no attribute it did not vet.
  //
  // The finished anchor is PARKED, not left in the string. The bare-URL pass runs after this and would otherwise find
  // the href it just wrote and linkify the URL inside the attribute, nesting one anchor inside another's href. Parking
  // it means the URL pass never sees a character this function already turned into markup.
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, label, href) => done(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  // A leading heading or blockquote marker is structure, not text: the row IS the heading, so the hashes go.
  out = out.replace(/^(#{1,6})\s+(.*)$/, (m, h, rest) => `<b>${rest}</b>`).replace(/^&gt;\s+/, "");
  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => done(`<code>${code[Number(i)]}</code>`));
}

/** Escape text, then turn URLs, file paths and markdown inside it into markup. Escaping first is what keeps this safe:
 *  every replacement operates on already-escaped text and inserts only markup this function wrote. */
function linkify(text, { fileHref, markdown } = {}) {
  let html = esc(text);
  // Markup this function has finished with, parked so no later pass can look inside it. A URL in an href and a `*` in
  // a code span are both cases where a later regex would otherwise edit markup rather than text.
  const built = [];
  const done = markup => `\u0001${built.push(markup) - 1}\u0001`;
  if (markdown) html = md(html, done);
  html = html.replace(URL_RE, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${short(u)}</a>`);
  if (fileHref) {
    html = html.replace(PATH_RE, p => {
      const href = fileHref(p);
      return href ? `<a href="${href}" class="fl">${p}</a>` : p;
    });
  }
  return html.replace(/\u0001(\d+)\u0001/g, (m, i) => built[Number(i)]);
}

// ---- blocks ---------------------------------------------------------------------
// The block level of a model's markdown. `report` in lib/harness_log.mjs did the scanning, because that is where the
// whole multi-line string exists before it is split into rows; these five functions only turn a scanned block into
// markup. Same discipline as `md`: escape first, write only tags this file wrote, vet every attribute.
//
// A block is ONE row. That keeps every existing property of the pane: `paint` counts rows for the MAX_LINES cap,
// `trim` indexes rows past the loaded history, and a heartbeat finds its row by `data-id`. A table that rendered as
// six rows would make the cap eat a table's header and leave its body, which reads worse than either.

/** A prose cell: escaped, then the inline pass, then links. The one entry point a block's text may use. */
const inline = (text, opts) => linkify(text, { ...opts, markdown: true });

/**
 * A fenced code block, verbatim.
 *
 * This is the fix with the most value in it. Every line of a fence used to go through the inline pass, which reads a
 * `*` as emphasis and DELETES the asterisks: a shell glob or a pointer dereference inside a code block came out with
 * characters missing. Inside a `<pre>` nothing is markdown, so the body is escaped and nothing else touches it.
 *
 * `lang` is the model's own word off the fence line, so it is not written into a class until it is vetted: letters,
 * digits, `+`, `-` and `#` only, lowercased, and capped. A language nobody styles is harmless; a language that could
 * close the attribute is not, which is why the test is a whitelist and not an escape. No highlighter is loaded: the
 * CSP is `script-src 'self'` and a highlighter would be both a fetch and tens of kilobytes for prettier keywords.
 */
function fence(p) {
  const lang = /^[A-Za-z0-9+#-]{1,20}$/.test(p.lang || "") ? ` data-lang="${p.lang.toLowerCase()}"` : "";
  // An unclosed fence is marked so the pane can say the block is still arriving rather than looking like a finished
  // one that happens to end mid-statement. It renders as the <pre> it already is.
  const open = p.open ? " open" : "";
  return `<div class="ll fence${open}"${lang}><pre>${esc(p.code || "")}</pre></div>`;
}

/**
 * A list, as a real `<ul>` or `<ol>`.
 *
 * Nesting is by depth rather than by recursion: `report` already measured each item's indent, and a list three levels
 * deep in a log pane is rare enough that a flat list with an indent class reads the same and cannot go wrong on a
 * ragged indent. That is the deliberate limit, not an oversight: real nesting would need a tree and the failure mode
 * of a tree built from agent output is a list that swallows its siblings.
 */
function list(p, opts) {
  const tag = p.ordered ? "ol" : "ul";
  const items = (p.items || []).map(it => {
    const d = Number(it.depth) || 0;
    const cls = d > 0 ? ` class="d${Math.min(3, d)}"` : "";
    return `<li${cls}>${inline(it.text || "", opts)}</li>`;
  }).join("");
  return `<div class="ll blk"><${tag} class="md">${items}</${tag}></div>`;
}

/**
 * A pipe table.
 *
 * The header's width is the table's width. Agent tables are ragged often enough that trusting each row's own cell
 * count would build a table the browser reflows per row; padding short rows and dropping cells past the header keeps
 * the columns aligned, which is the only reason to draw a table rather than the lines it was written as.
 *
 * The wrapper scrolls on its own. A wide table inside the pane must not widen the pane, because the pane sits in the
 * layout grid and a table that pushes it out moves the whole column instead of scrolling inside it.
 */
function table(p, opts) {
  const head = Array.isArray(p.head) ? p.head : [];
  const width = head.length;
  if (!width) return "";
  const th = head.map(c => `<th>${inline(c, opts)}</th>`).join("");
  const body = (Array.isArray(p.rows) ? p.rows : []).map(row => {
    const cs = Array.isArray(row) ? row : [];
    // Exactly `width` cells, every time: short rows gain empty ones and long rows lose the overflow.
    const tds = [];
    for (let i = 0; i < width; i++) tds.push(`<td>${inline(cs[i] ?? "", opts)}</td>`);
    return `<tr>${tds.join("")}</tr>`;
  }).join("");
  return `<div class="ll blk"><div class="tw"><table class="md"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

/** A run of `>` lines as one blockquote, rather than the marker stripped off each line and the rows left apart. */
function quote(p, opts) {
  const lines = (Array.isArray(p.lines) ? p.lines : []).map(l => String(l));
  // A blank line inside the quote is a paragraph break in it, so runs are joined and the breaks kept.
  const paras = [];
  let held = [];
  for (const l of lines) {
    if (!l.trim()) { if (held.length) { paras.push(held.join(" ")); held = []; } continue; }
    held.push(l.trim());
  }
  if (held.length) paras.push(held.join(" "));
  const body = paras.map(t => `<p>${inline(t, opts)}</p>`).join("");
  return `<div class="ll blk"><blockquote>${body}</blockquote></div>`;
}

/** A URL short enough to read in a narrow panel: host plus the last meaningful segment. */
function short(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const tail = parts.length ? "/" + parts[parts.length - 1] : "";
    const host = u.hostname.replace(/^www\./, "");
    const s = host + (tail.length > 28 ? tail.slice(0, 27) + "…" : tail);
    return esc(s.length > 48 ? s.slice(0, 47) + "…" : s);
  } catch { return esc(url.length > 48 ? url.slice(0, 47) + "…" : url); }
}

/** How long a call has been running, as the shortest thing that reads: "30s", "4m 30s". */
function elapsed(secs) {
  // null and "" both become 0 through Number(), and "running 0s" reads as a fact the harness did not state. Only a
  // number the harness actually sent gets a time on it.
  const s = typeof secs === "number" ? secs : NaN;
  if (!Number.isFinite(s) || s < 0) return "running";
  return s < 60 ? `running ${Math.round(s)}s` : `running ${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * One line as the rows it means, always a list.
 *
 * One event can be several rows: a harness that batches parallel tool calls into one message writes one line and
 * means three. The pane needs the rows rather than their markup, because a heartbeat row is applied to a row already
 * on screen rather than appended, and that decision cannot be made once the row is a string.
 */
function renderRows(line, opts = {}) {
  const p = parseLine(line, opts);
  return Array.isArray(p) ? p : [p];
}

/** One line as HTML. Paths are left as text here: the tracker has no file browser to open them in. */
function renderLine(line, opts = {}) {
  return renderRows(line, opts).map(one => renderParsed(one, opts)).join("");
}

/** One classified row as HTML. */
function renderParsed(p, opts) {
  // The reader recognised the event and there is nothing to say about it: a tool result that succeeded. Only a
  // reader may ask for this; a line that failed to parse renders as itself instead.
  if (p.kind === "skip") return "";
  // A blocked tool call is the one line in a run an operator must not scroll past, so it is not a tool row with a
  // colour: it keeps the closing line's weight and border, in the failure colour, which is the loudest thing this
  // stylesheet has. `.ll.d.bad` already exists for the run that failed; a denial is the same class of news.
  if (p.kind === "deny") {
    return `<div class="ll d bad"><span class="n">${esc(p.tool || "BLOCKED")}</span> ${linkify(p.arg || "", opts)}</div>`;
  }
  // A heartbeat for a call that is still running. It belongs on the row that call already has, which `paint` does by
  // finding `data-id` and writing the elapsed time into the row's own `.e` span. Reached here only when the row is
  // gone (the cap trimmed it, or the pane opened after the call started), and then a row of its own is better than
  // nothing: a Bash step alive for four minutes is the thing the reader was waiting to be told.
  if (p.kind === "beat") {
    return `<div class="ll t meta"><span class="n">${esc(p.tool || "tool")}</span><span class="a">${esc(elapsed(p.secs))}</span></div>`;
  }
  if (p.kind === "tool") {
    const arg = p.arg ? `<span class="a">${linkify(p.arg, opts)}</span>` : "";
    // `data-id` is the call's tool_use_id when the harness gave one, so a heartbeat can find this row and count up on
    // it. Absent otherwise, and the row is then byte for byte what it always was.
    const id = p.id ? ` data-id="${esc(p.id)}"` : "";
    return `<div class="ll t${p.tone ? " " + p.tone : ""}"${id}><span class="n">${esc(p.tool)}</span>${arg}</div>`;
  }
  if (p.kind === "head") return `<div class="ll h">${linkify(p.text, opts)}</div>`;
  if (p.kind === "done") return `<div class="ll d ${p.ok ? "ok" : "bad"}">${linkify(p.text, opts)}</div>`;
  // A line no reader claimed: the harness's own stderr, a truncated write, a runner line. Escaped, linkified, and
  // nothing else: no markdown pass, because nobody wrote this as markdown and the pass can delete characters from it.
  if (p.kind === "raw") return `<div class="ll raw">${linkify(p.text, opts)}</div>`;
  // The block level of the markdown a model wrote, which `report` in lib/harness_log.mjs has already scanned into
  // blocks. Each of these is one row, so the pane's cap and its heartbeat lookup still count rows the way they did.
  if (p.kind === "fence") return fence(p);
  if (p.kind === "list") return list(p, opts);
  if (p.kind === "table") return table(p, opts);
  if (p.kind === "quote") return quote(p, opts);
  if (p.kind === "rule") return `<div class="ll hr"></div>`;
  // Markdown is read on prose rows only. A tool argument is a shell command or a path, where a `*` is a glob and an
  // `_` is part of a name, so reading either as emphasis would corrupt the one thing that row exists to show. The
  // closing line is generated text with no markdown in it. Prose is the only place the model was writing markdown.
  return `<div class="ll">${linkify(p.text, { ...opts, markdown: true })}</div>`;
}
