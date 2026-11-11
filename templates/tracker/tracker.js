// Log stream, bounded history and local text rendering.
// ---- log pane -------------------------------------------------------------------
const pane = document.getElementById("log"), state = document.getElementById("logstate");
// The most LIVE rows the pane keeps. Beyond this the oldest live rows are dropped; the complete log is on disk and the
// "load earlier" control fetches any of it back.
//
// Explicitly loaded history has its own cap. Live rows never evict that window;
// another page can replace older history without growing browser memory forever.
const MAX_LINES = 2000;
const MAX_HISTORY_LINES = 2000;
if (pane) {
  // Auto-scroll follows the reader: the pane jumps to the bottom only when it was already at the bottom, so
  // scrolling up to read something does not yank you back down on the next line.
  const atBottom = () => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  // Lines arrive in bursts: a reconnect delivers hundreds at once, and a busy harness writes faster than the screen
  // refreshes. Appending per line stalled the main thread badly enough that the browser dropped the stream and
  // retried, which replayed the burst, which stalled it again. Buffer and paint once per frame instead.
  let pending = [], painting = false, closed = false, disconnected = false;
  const follow = document.getElementById("follow-output");
  const search = document.getElementById("activity-search"), searchState = document.getElementById("activity-search-state");
  let paused = false, unseen = 0, terminalPending = null, matchIndex = -1;
  const nextMatch = document.getElementById("activity-next");
  nextMatch?.addEventListener("click", () => {
    const matches = [...pane.querySelectorAll(".search-match")];
    if (!matches.length) return;
    matchIndex = (matchIndex + 1) % matches.length;
    pane.scrollTop += matches[matchIndex].getBoundingClientRect().top - pane.getBoundingClientRect().top - 24;
  });
  const announce = count => {
    unseen += count;
    if (follow) { follow.hidden = false; follow.textContent = `${unseen || "New"} new events · Follow live output`; }
  };
  const searchLoaded = () => {
    if (!search) return;
    const term = search.value.trim().toLowerCase();
    let count = 0;
    for (const row of pane.children) {
      const match = Boolean(term && row.textContent.toLowerCase().includes(term));
      row.classList.toggle("search-match", match); if (match) count++;
    }
    if (nextMatch) nextMatch.disabled = count === 0;
    searchState.textContent = term ? `${count} matching rows in loaded output only. Load earlier lines to search older history.` : "Search covers loaded output only; older history remains paginated.";
  };
  search?.addEventListener("input", () => { matchIndex = -1; searchLoaded(); });
  pane.addEventListener?.("scroll", () => { if (!atBottom() && follow) { paused = true; follow.hidden = false; follow.textContent = unseen ? `${unseen} new events · Follow live output` : "Auto-scroll paused · Follow live output"; } });
  follow?.addEventListener("click", () => {
    globalThis.getSelection?.()?.removeAllRanges();
    paused = false; unseen = 0; paint();
    if (terminalPending) { note(terminalPending.slice(1, -1), "d"); terminalPending = null; }
    pane.scrollTop = pane.scrollHeight; follow.hidden = true;
  });
  let es, lastEventId = null;
  // Reaching back: `oldest` is the id of the oldest line the pane holds (what the history route takes as
  // `?before=`), `loaded` is how many rows the reader explicitly loaded, which the cap exempts, and `busy`
  // keeps two presses of the button from fetching the same window twice. Declared with the rest of the pane's
  // state because `trim` reads `loaded` and runs from `paint`.
  let oldest = null, loaded = 0, busy = false, historyRequest = null, historyWindowed = false;
  // Coalesce missing display ranges into two IDs, rather than an unbounded queue.
  // This cursor can recover a burst between rows already painted on the page.
  let recoveryBefore = null, recoveryFloor = null;
  const replayId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const eventHtml = (row, id, index) => {
    const html = renderParsed(row, { harness });
    return id === null ? html : html.replace(/^(<div class="[^"]*")/, '$1 data-replay="' + id + '" data-replay-row="' + index + '"');
  };
  const rememberDropped = (id, before) => {
    if (id === null || before === null) return;
    recoveryFloor = Math.min(recoveryFloor ?? id, id);
    recoveryBefore = Math.max(recoveryBefore ?? before, before);
    offer(recoveryBefore - 1);
  };
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
      const id = replayId(victim.dataset.replay);
      rememberDropped(id, id === null ? null : id + 1);
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
    if (!pending.length) return;
    const selection = globalThis.getSelection?.();
    const selecting = selection && !selection.isCollapsed && pane.contains?.(selection.anchorNode);
    if (selecting && follow && !paused) { paused = true; announce(pending.length); }
    // Freeze a full paused window (or selected text), retaining only the bounded
    // pending queue. Dropped events remain recoverable through the gap cursor.
    if (paused && (selecting || pane.childElementCount >= MAX_LINES + loaded)) return;
    const stick = atBottom() && !paused;
    // Markup goes in first, heartbeats are applied second. That order matters: a burst can carry the call and its
    // first heartbeat together, and applying the beat before the row existed would have drawn a duplicate row.
    //
    // The markup is appended to the pane itself rather than inside a wrapper div. The cap below counts the pane's
    // children, and a wrapper per frame made one paint of three hundred lines count as a single child, so the cap
    // never fired and the DOM grew without bound on a long run.
    const rows = pending.flatMap(event => renderRows(event.line, { harness }).map((row, index) => ({ row, id: event.id, index })));
    pending = [];
    const html = rows.filter(r => r.row.kind !== "beat").map(r => eventHtml(r.row, r.id, r.index)).join("");
    if (html) { const t = document.createElement("template"); t.innerHTML = html; pane.append(t.content); }
    // A heartbeat whose row is not on the pane (trimmed by the cap, or the pane opened after the call started) still
    // deserves to be said: a Bash step alive for four minutes with nothing on screen is the complaint this answers.
    const orphans = rows.filter(r => r.row.kind === "beat" && !beat(r.row));
    if (orphans.length) {
      const t = document.createElement("template");
      t.innerHTML = orphans.map(r => eventHtml(r.row, r.id, r.index)).join("");
      pane.append(t.content);
    }
    if (stick) pane.scrollTop = pane.scrollHeight;
    // A very long pane costs memory and scroll performance for lines nobody scrolls back to. The whole log is on
    // disk, and the "load earlier" control above can fetch any of it back, so dropping the oldest rows loses nothing.
    trim();
    searchLoaded();
  };
  const push = (line, id) => {
    if (paused) announce(1);
    if (oldest === null && id !== null) oldest = id;
    if (pending.length >= 400) {
      const dropped = pending.shift();
      rememberDropped(dropped.id, pending[0]?.id ?? id);
      tell("display buffer full; older events remain in paginated history");
    }
    pending.push({ line, id }); if (!painting) { painting = true; requestAnimationFrame(paint); }
  };
  const note = (text, cls) => { const el = document.createElement("div"); el.className = "ll " + cls; el.textContent = text; pane.append(el); trim(); };
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
    if (disconnected || busy || (recoveryBefore ?? oldest ?? 0) <= 1) return;
    const active = lifecycle.guard();
    const recovering = recoveryBefore !== null, cursor = recoveryBefore ?? oldest;
    busy = true;
    const request = historyRequest = new AbortController();
    if (earlier) earlier.disabled = true;
    tell("loading");
    try {
      const h = new URLSearchParams(q);
      h.set("before", String(recovering ? cursor : oldest));
      const r = await fetch(BASE + "/api/run/history?" + h.toString(), { headers: { accept: "application/json" }, signal: request.signal });
      if (!r.ok) throw new Error("history " + r.status);
      const got = await r.json();
      if (disconnected || !active()) return;
      const lines = Array.isArray(got.lines) ? got.lines : [];
      const present = new Set([...pane.children].filter(row => replayId(row.dataset.replay) !== null).map(row => `${row.dataset.replay}:${row.dataset.replayRow ?? 0}`));
      const queued = new Set(pending.map(event => event.id).filter(id => id !== null));
      const html = lines.flatMap((line, i) => {
        const id = replayId(got.ids?.[i] ?? (Number.isSafeInteger(got.from) ? got.from + i : null));
        if (id !== null && queued.has(id)) return [];
        return renderRows(line, { harness }).flatMap((row, index) => id !== null && present.has(`${id}:${index}`) ? [] : eventHtml(row, id, index));
      }).join("");
      const before = pane.scrollHeight, top = pane.scrollTop;
      if (html) {
        const t = document.createElement("template");
        t.innerHTML = html;
        // How many rows this actually added, counted from the template rather than from `lines`: one event can be
        // several rows and a clean tool result is none, so the line count is not the row count and the cap needs the
        // row count.
        if (recovering) {
          // A gap may lie between painted rows. Merge by stable replay ID,
          // keeping the existing tool rows and heartbeat state intact.
          for (const row of [...t.content.children]) {
            const id = replayId(row.dataset.replay);
            const index = Number(row.dataset.replayRow ?? 0);
            const next = [...pane.children].find(el => replayId(el.dataset.replay) > id || (replayId(el.dataset.replay) === id && Number(el.dataset.replayRow ?? 0) > index));
            pane.insertBefore(row, next ?? null);
          }
          const firstLive = [...pane.children].findIndex(row => (replayId(row.dataset.replay) ?? 0) >= cursor);
          loaded = Math.max(loaded, firstLive < 0 ? pane.childElementCount : firstLive);
        } else {
          loaded += t.content.childElementCount;
          pane.prepend(t.content);
        }
        // Keep the older page just requested; evict the newest history beside
        // the live tail so another click can actually reach earlier output.
        while (loaded > MAX_HISTORY_LINES && pane.children[loaded - 1]) { pane.children[loaded - 1].remove(); loaded--; historyWindowed = true; }
        trim();
      }
      pane.scrollTop = top + (pane.scrollHeight - before);
      searchLoaded();
      if (Number.isSafeInteger(got.from) && got.from > 0) oldest = Math.min(oldest ?? got.from, got.from);
      if (recovering && recoveryBefore === cursor) {
        if ((got.from ?? cursor) <= recoveryFloor || (got.before ?? 0) <= 0) recoveryBefore = recoveryFloor = null;
        else recoveryBefore = got.from;
      }
      offer(recoveryBefore !== null ? recoveryBefore - 1 : Math.min(got.before ?? 0, (oldest ?? 1) - 1));
      if (got.gap) { note(got.gap, "skip"); tell("some history is unavailable; saved results are separate from logs"); }
      else if (recoveryBefore === null && (got.before ?? 0) <= 0) tell("this is the first line of the run");
      if (historyWindowed) tell(`${earlierState?.textContent || ""} · History capped at 2,000 rows; middle output omitted. Reopen this attempt to reset to its tail.`);
    } catch {
      if (disconnected || !active()) return;
      // The pane is the only place a reader sees this, so it says what happened rather than going quiet. The button
      // stays available: a failed fetch is worth retrying and nothing was consumed.
      tell("Could not load earlier lines; displayed output retained. Retry load earlier lines after restoring the local connection.");
    } finally {
      if (historyRequest === request) {
        busy = false; historyRequest = null;
        if (earlier) earlier.disabled = (recoveryBefore ?? oldest ?? 0) <= 1;
      }
    }
  };
  earlier?.addEventListener("click", loadEarlier);

  globalThis.addEventListener?.("pagehide", event => {
    // Finish the bounded display batch before recording the reconnect cursor.
    if (event?.persisted) paint();
    disconnected = true; es.close(); pending = [];
    if (historyRequest) tell("Loading paused; load earlier lines to retry.");
    historyRequest?.abort(); historyRequest = null; busy = false;
  });
  lifecycle.onResume(() => {
    disconnected = false;
    if (earlier) earlier.disabled = (recoveryBefore ?? oldest ?? 0) <= 1;
    if (!closed) connect();
  });
  const say = text => { if (state) { state.textContent = text; state.classList?.toggle("loading", text === "reconnecting"); } };
  const connect = () => {
    const active = lifecycle.guard();
    // EventSource cannot set Last-Event-ID on a new connection. Its initial URL
    // carries the same cursor; subsequent network retries use the normal header.
    say("reconnecting");
    es = new EventSource(lastEventId === null ? url : url + "&after=" + lastEventId);
    es.addEventListener("gap", e => { if (!active()) return; note(JSON.parse(e.data), "skip"); tell("some history is unavailable; saved results are separate from logs"); });
    es.addEventListener("skipped", e => {
      if (!active()) return;
      const n = Number(e.data);
      if (!Number.isFinite(n) || n <= 0) return;
      note(n + ' earlier lines not shown; "load earlier lines" above fetches them, and the whole log is in the run folder', "skip");
      // The tail starts at line n+1, so the oldest line the pane holds is n+1 and the window before it starts at n.
      oldest ??= n + 1;
      offer(recoveryBefore !== null ? recoveryBefore - 1 : n);
    });
    es.onmessage = e => {
      if (!active()) return;
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
        if (pending.length) terminalPending = text;
        else note(text.slice(1, -1), "d " + (text === "[exit 0]" ? "ok" : "bad"));
        say(text === "[no run]" ? "no run on disk" : text === "[exit 0]" ? "finished" : text.slice(1, -1));
        return;
      }
      if (!closed) {
        const receivedId = replayId(e.lastEventId);
        if (receivedId !== null && lastEventId !== null && receivedId <= lastEventId) return;
        lastEventId = receivedId ?? lastEventId;
        push(text, replayId(e.lastEventId));
      }
    };
    es.onopen = () => { if (active()) say("live"); };
    // readyState 2 is closed, which is the normal end of a finished run and not a failure to report.
    es.onerror = () => { if (active() && es.readyState !== 2) say("Output disconnected; displayed lines retained. Reconnecting to the same attempt; check the local server connection."); };
  };
  connect();
}
