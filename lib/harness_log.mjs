// One line of a harness's JSONL output -> the shape command-center's log renderer already takes.
//
// This sits beside lib/harness.mjs because it is the same knowledge: each harness's stream has its own event names
// and its own nesting, exactly as `outcome` and `sessionFrom` already have to know. Putting the reader in the
// tracker would mean the tracker knowing five stream shapes, and a sixth harness would then be edited in two files.
//
// The renderer it feeds is command-center's public/logline.js, ported into templates/tracker/tracker.js. That file
// takes { kind, tool, arg } and nothing else, so everything below is a mapping onto those three fields. Which is why
// the parse can differ per harness while the rendering stays one copy.
//
// No library, for the same reason command-center has none: the whole job is JSON.parse plus a field lookup. A parse
// that fails, or an event shape nothing here recognises, returns null and the caller shows the raw line instead. A
// line nobody can read is still information, and blanking it would hide the one line an operator needed.
//
// This module has no imports on purpose: the browser gets it by having lib/tracker/assets.mjs splice its source
// into the served script, so there is one copy of the parse rather than two that drift.

/** The tool-call inputs worth putting in the argument column, in the order they are preferred. */
const ARG_KEYS = ["command", "file_path", "pattern", "url", "description", "prompt"];

/** The first of ARG_KEYS the input actually has, as a single line. */
const argOf = input => {
  if (!input || typeof input !== "object") return "";
  for (const k of ARG_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return oneLine(v);
    if (typeof v === "number") return String(v);
  }
  return "";
};

/** Newlines collapse: a row is one line tall, and a heredoc in a Bash command would otherwise be forty. */
const oneLine = s => String(s).replace(/\s*\n\s*/g, " ").trim();

/**
 * A hook decision, from the JSON the hook printed on stdout. APort's Claude Code hook writes Claude's official
 * schema: `{ hookSpecificOutput: { permissionDecision, permissionDecisionReason } }`, and "deny" there is a blocked
 * tool call. That is the single most important line a run can produce, so it gets its own kind rather than arriving
 * as another "meta" tool row the eye slides past.
 */
function hookDecision(ev) {
  const raw = ev.output || ev.stdout || "";
  let out = null;
  if (raw && typeof raw === "string") { try { out = JSON.parse(raw); } catch { out = null; } }
  const spec = out?.hookSpecificOutput || null;
  const decision = spec?.permissionDecision || out?.decision || null;
  const reason = spec?.permissionDecisionReason || out?.reason || "";
  // exit 2 blocks as well, with the reason on stderr, and the hook's own header documents that path.
  const blockedByExit = ev.exit_code === 2;
  if (decision === "deny" || blockedByExit) {
    return { kind: "deny", tool: "BLOCKED", arg: oneLine(reason || ev.stderr || `${ev.hook_name || "hook"} blocked the call`) };
  }
  return null;
}

/**
 * Claude Code. `--output-format stream-json --verbose`, verified against the run tree under ~/.gallivant/runs on
 * 2026-09-27: assistant (tool_use and text blocks), user (tool results), system (init, hook_started, hook_response,
 * task_started, task_notification), rate_limit_event, tool_progress, result.
 */
function claudeLine(ev) {
  // A heartbeat for a call that is still running. Claude Code emits one every 30 seconds for a tool that has not
  // returned, and a long Bash step collects a dozen of them: on the run this was read off, one `npm ci` gathered
  // fourteen. Drawing each as its own row would be fourteen identical lines of noise; skipping them the way a clean
  // tool result is skipped would throw away the one thing the reader wanted, because a build sitting for six minutes
  // with nothing on screen is exactly the case they complained about.
  //
  // So it is neither a row nor nothing: it is an UPDATE to the row the call already has. `parent_tool_use_id` names
  // that call, tool rows carry their own id, and the renderer finds the row and rewrites its elapsed time in place.
  // One row that counts upwards, which is what a progress indicator is. `kind` says "beat" rather than "tool" so no
  // caller can mistake it for a call of its own.
  if (ev.type === "tool_progress") {
    const id = ev.parent_tool_use_id || ev.tool_use_id || "";
    const secs = Number(ev.elapsed_time_seconds);
    return { kind: "beat", of: String(id), tool: ev.tool_name || "tool", secs: Number.isFinite(secs) ? secs : null };
  }
  if (ev.type === "assistant") {
    const blocks = ev.message?.content || [];
    // One event can carry prose and several tool calls at once: Claude batches parallel calls into one message. So a
    // line can be more than one row, and the renderer joins them. Order is kept, which is the order the model wrote
    // them in, so the prose that introduces a batch of calls still reads above the calls.
    const rows = [];
    for (const b of blocks) {
      // `id` is the call's own tool_use_id, carried so a later `tool_progress` heartbeat can find this row and count
      // up on it rather than adding one of its own. Nothing else reads it and it is absent when the harness omits it.
      if (b?.type === "tool_use") rows.push({ kind: "tool", tool: b.name || "tool", arg: argOf(b.input), id: b.id ? String(b.id) : "" });
      // Prose the model wrote is markdown, and a long one is a report with headings and lists in it. It gets the same
      // treatment the final message does, for the same reason: one row a screen wide is the thing this rendering
      // exists to stop, and the model's own paragraph breaks are the only structure worth keeping.
      else if (b?.type === "text" && b.text?.trim()) rows.push(...report(b.text));
    }
    return rows.length === 0 ? null : rows.length === 1 ? rows[0] : rows;
  }
  // Tool results. A success is not news: its output is what the run read, often hundreds of lines of it, and the
  // pane is a narrative of what the run is DOING. So a clean result is recognised and dropped rather than shown
  // raw, which is the one case where "nothing" is the right row and not a parse failure.
  if (ev.type === "user") {
    const blocks = ev.message?.content || [];
    const bad = blocks.find(b => b?.type === "tool_result" && b.is_error);
    if (!bad) return blocks.some(b => b?.type === "tool_result") ? { kind: "skip" } : null;
    const why = oneLine(resultText(bad.content));
    // A guardrail refusal comes back as an error result, not as a hook event: the hook denies, Claude turns the
    // denial into the tool's result, and `tool_result_meta.non_execution_kind` says the tool never ran. Verified
    // against a live run on 2026-09-27, where APort blocked two Bash calls. That is the line an operator is
    // scanning for, so it does not get to look like a tool that merely errored.
    const blocked = (ev.tool_result_meta || []).some(m => m?.non_execution_kind === "permission-rule") || /^APort denied\b/.test(why);
    if (blocked) return { kind: "deny", tool: "BLOCKED", arg: why.slice(0, 400) };
    return { kind: "tool", tool: "ERROR", arg: why.slice(0, 300), tone: "bad" };
  }
  if (ev.type === "system") {
    if (ev.subtype === "hook_response") return hookDecision(ev) || { kind: "tool", tool: "hook", arg: `${ev.hook_name || "hook"} ${ev.outcome || ""}`.trim(), tone: "meta" };
    if (ev.subtype === "hook_started") return { kind: "tool", tool: "hook", arg: ev.hook_name || ev.hook_event || "started", tone: "meta" };
    if (ev.subtype === "init") return { kind: "head", text: `session ${ev.session_id || "?"} in ${ev.cwd || "?"}` };
    if (ev.subtype === "task_started") return { kind: "tool", tool: "task", arg: ev.description || ev.task_id || "started", tone: "meta" };
    if (ev.subtype === "task_notification") return { kind: "tool", tool: "task", arg: `${ev.summary || ev.task_id || "task"} ${ev.status || ""}`.trim(), tone: "meta" };
    return { kind: "tool", tool: "system", arg: ev.subtype || "", tone: "meta" };
  }
  if (ev.type === "rate_limit_event") {
    const i = ev.rate_limit_info || {};
    return { kind: "tool", tool: "limits", arg: `${i.rateLimitType || "rate limit"} ${i.status || ""}`.trim(), tone: "meta" };
  }
  if (ev.type === "result") {
    // `errors` and `terminal_reason` are the SHORT reason; `subtype` (error_max_budget_usd) is the fallback. The
    // model's own report goes above as prose, so a run that ended mid-task still says why, in its own words.
    const why = (ev.errors || []).join("; ") || ev.terminal_reason || ev.subtype || "";
    return [...report(ev.result), done(!ev.is_error, why, ev.total_cost_usd)];
  }
  return null;
}

/** A tool result's content, which is a string on some events and a block list on others. */
const resultText = content => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => (typeof c === "string" ? c : c?.text || "")).join(" ");
  return "";
};

/**
 * The closing line. Same shape command-center's DONE regex produces, so the renderer's `.ll.d` row with its top
 * border and its ok/bad colour needs no change: only the text differs, and the cost is the part an operator reads.
 *
 * `why` is a SHORT reason, never the model's report. A Claude `result` event carries the whole final message in
 * `result`, which on the run this was built against was twelve paragraphs of markdown. Collapsed onto the closing
 * line that became one unreadable row a screen wide, which is the bug this rendering exists to stop. The report is
 * prose and is emitted as prose above the closing line by the caller; this function only ever gets the reason.
 */
function done(ok, why, cost) {
  const parts = [ok ? "done" : "failed"];
  if (typeof cost === "number") parts.push(`$${cost.toFixed(4)}`);
  if (!ok && why) parts.push(oneLine(why).slice(0, 120));
  return { kind: "done", text: parts.join(" "), ok };
}

/** A fence opener or closer: three or more backticks or tildes, with an optional language word on the opener. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
/** A list item: a bullet or a number, with the indent kept so a nested item can be told from a top-level one. */
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
/** A table row: a line fenced by pipes at both ends, so a sentence that merely contains a `|` is not read as one. */
const PIPE = /^\s{0,3}\|.*\|\s*$/;
/** The separator row under a table's header: pipes, dashes, colons and nothing else. */
const RULER = /^\s{0,3}\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;
/**
 * A horizontal rule: three or more of the same marker on a line of its own, spaces between them allowed, so `* * *`
 * is a rule rather than a bullet list holding `* *`. It cannot collide with RULER, which needs pipes and this one
 * allows none, so which of the two is tested first does not matter.
 */
const HR = /^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/;
/** A blockquote line. The marker is structure and the text after it is what the quote holds. */
const QUOTE = /^\s{0,3}>\s?(.*)$/;
/** A heading. Kept as its own row so the renderer can give it the weight the model asked for. */
const HEAD_MD = /^\s{0,3}(#{1,6})\s+(.*)$/;

/** A pipe row's cells, with the outer pipes dropped. An escaped `\|` is a pipe in a cell, not a cell boundary. */
const cells = row => row.trim().replace(/^\|/, "").replace(/\|\s*$/, "")
  .split(/(?<!\\)\|/).map(c => oneLine(c).replace(/\\\|/g, "|"));

/**
 * The model's final message, as the blocks it wrote.
 *
 * It arrives as one JSON string holding markdown. Rendering it line at a time is what the reader complained about:
 * a fenced code block came out as N prose rows with the emphasis characters inside it eaten, a pipe table came out as
 * rows of literal pipes, and a bullet list came out as rows each starting with a dash. So the split is a block scan
 * rather than a regex on paragraph boundaries, and each block becomes one row the renderer knows how to draw.
 *
 * Six block kinds, which is every one that appears in the run tree under ~/.gallivant/runs:
 *
 *   { kind: "text",  text }               a paragraph, or a heading, with its wrapped lines joined
 *   { kind: "fence", code, lang }         a fenced block, verbatim, never touched by the inline pass
 *   { kind: "list",  items, ordered }     a run of bullets or numbers, as { text, depth }
 *   { kind: "table", head, rows }         a pipe table with its separator row seen
 *   { kind: "quote", lines }              a run of `>` lines
 *   { kind: "rule" }                      a horizontal rule
 *
 * A fence wins over everything: inside one, a `|` is a pipe and a `-` is a dash and no other rule looks at the line.
 * That is the whole point of a fence and it is why the scan is a state machine rather than six independent splits.
 *
 * An UNCLOSED fence is the case streaming makes ordinary, because half a report is on screen while the rest is still
 * arriving. It does not swallow the rest of the report and it does not throw: the lines collected so far come back as
 * a fence row that renders as the `<pre>` it will become, so the reader sees the code they already have. The next
 * event's rows are appended under it as usual. Same for a pipe table whose separator row has not arrived: without a
 * ruler it is not a table, so its lines are paragraphs, which is what they look like anyway.
 */
function report(message) {
  const text = typeof message === "string" ? message : "";
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const out = [];
  // A paragraph is collected across lines and flushed when something ends it, so a wrapped sentence still joins.
  let para = [];
  const flushPara = () => { const t = oneLine(para.join("\n")); para = []; if (t) out.push({ kind: "text", text: t }); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ---- a fence, which owns every line until its own closer --------------------
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const [, marker, lang] = fence;
      const body = [];
      let closed = false;
      // A closer is the same marker, at least as long, with nothing after it. A ``` inside a ~~~ block is content.
      const closer = new RegExp(`^\\s{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      for (i++; i < lines.length; i++) {
        if (closer.test(lines[i])) { closed = true; break; }
        body.push(lines[i]);
      }
      // `lang` is the model's own word and reaches the renderer as a class, which vets it. An unclosed fence still
      // produces its row: the code that did arrive is what the reader wants to see.
      out.push({ kind: "fence", code: body.join("\n"), lang: lang || "", open: !closed });
      continue;
    }

    // ---- a blank line ends whatever was being collected ------------------------
    if (!line.trim()) { flushPara(); continue; }

    // ---- a heading is its own row ----------------------------------------------
    const head = HEAD_MD.exec(line);
    if (head) { flushPara(); out.push({ kind: "text", text: oneLine(line) }); continue; }

    // ---- a horizontal rule ------------------------------------------------------
    // Before the list rule, because `* * *` is a rule and not three bullets. A table's ruler row cannot reach here:
    // it needs pipes and HR allows none.
    if (HR.test(line)) { flushPara(); out.push({ kind: "rule" }); continue; }

    // ---- a table, but only once its separator row is in hand -------------------
    // The ruler is what makes a run of pipe lines a table rather than prose that happens to contain a pipe. It has to
    // be the line after the header, so the lookahead is one line and no further.
    if (PIPE.test(line) && i + 1 < lines.length && RULER.test(lines[i + 1])) {
      flushPara();
      const head2 = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && PIPE.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      // Ragged rows are normal in agent output: the renderer pads and clips to the header's width rather than
      // building a table whose cell count varies by row, which is what makes a browser reflow the columns.
      out.push({ kind: "table", head: head2, rows });
      continue;
    }

    // ---- a blockquote, as one block rather than a marker stripped per line ------
    const quote = QUOTE.exec(line);
    if (quote) {
      flushPara();
      const held = [quote[1]];
      for (i++; i < lines.length; i++) {
        const q = QUOTE.exec(lines[i]);
        if (!q) { i--; break; }
        held.push(q[1]);
      }
      // Blank lines inside the quote are kept as paragraph breaks and the renderer draws each run as its own line.
      out.push({ kind: "quote", lines: held });
      continue;
    }

    // ---- a list, as one block with its items ------------------------------------
    const item = ITEM.exec(line);
    if (item) {
      flushPara();
      const ordered = item[3] !== undefined;
      const items = [];
      // A continuation line under an item belongs to that item: the model wrapped it, and starting a new item for it
      // would read as a list twice as long as the one it wrote.
      const add = (indent, body) => items.push({ depth: Math.min(3, Math.floor(indent.replace(/\t/g, "  ").length / 2)), text: body });
      add(item[1], item[4]);
      for (i++; i < lines.length; i++) {
        const next = ITEM.exec(lines[i]);
        if (next) {
          // A bullet under a numbered list, or the other way, ends this list and starts the next: they are two lists
          // and one <ol> holding bullets would lie about what the model wrote.
          if ((next[3] !== undefined) !== ordered) { i--; break; }
          add(next[1], next[4]);
          continue;
        }
        // A blank line, a fence, a heading or a table ends the list. Anything else indented is a continuation.
        if (!lines[i].trim() || FENCE.test(lines[i]) || HEAD_MD.test(lines[i]) || PIPE.test(lines[i]) || HR.test(lines[i])) { i--; break; }
        if (/^\s/.test(lines[i])) { items[items.length - 1].text += " " + lines[i].trim(); continue; }
        i--;
        break;
      }
      out.push({ kind: "list", ordered, items: items.map(it => ({ ...it, text: oneLine(it.text) })) });
      continue;
    }

    para.push(line);
  }
  flushPara();
  return out;
}

/**
 * Codex. `exec --json`, captured from a real run against codex-cli 0.157.0 on 2026-09-27: thread.started,
 * turn.started, item.started and item.completed (each carrying an `item` with its own `type`), turn.completed.
 *
 * Two details the capture settled that guessing would have got wrong. A tool call fires TWICE, once as
 * `item.started` and again as `item.completed` with the output filled in, so drawing both would double every row:
 * the started event is what the pane wants, because it is the one that arrives while the call is running.
 * And `turn.completed.usage` carries token counts and no cost at all, so there is no cost to put on the closing
 * line; `outcome` in lib/harness.mjs already reports codex's cost as null for the same reason.
 *
 * Only `agent_message` and `command_execution` were observed. An item of any other type is a row named after its
 * own type with no argument, which says something happened without inventing a field name to describe it.
 */
function codexLine(ev) {
  if (ev.type === "thread.started") return { kind: "head", text: `thread ${ev.thread_id || "?"}` };
  // The completed twin of a call already on screen. Its output is the tool result, which the pane does not show.
  if (ev.type === "item.completed" && ev.item?.type === "command_execution") return { kind: "skip" };
  if (ev.type === "item.started" || ev.type === "item.completed") {
    const item = ev.item || {};
    // Prose arrives on `item.completed`; the started twin has no text yet and is nothing to draw.
    if (item.type === "agent_message") return item.text?.trim() ? report(item.text) : { kind: "skip" };
    if (item.type === "command_execution") return { kind: "tool", tool: "Bash", arg: oneLine(item.command || "") };
    return { kind: "tool", tool: item.type || "item", arg: "", tone: "meta" };
  }
  if (ev.type === "turn.started") return { kind: "skip" };
  if (ev.type === "turn.completed") return done(true, null, null);
  if (ev.type === "turn.failed" || ev.type === "error") return done(false, ev.error?.message || ev.message || "turn failed", null);
  return null;
}

/**
 * Gemini, opencode and goose. `outcome` in lib/harness.mjs names the events each one's OUTCOME is read from, and
 * those were round-tripped on this machine. The per-line shape was not: no run of any of the three has been
 * captured line by line here, so what a tool call looks like in their streams is not known the way it is for claude
 * and codex, both of which were read off real runs.
 *
 * So each of the three reads only the events lib/harness.mjs already proves exist, and returns null for the rest,
 * which shows the raw line. Guessing would be worse than a raw line: it would put a confident row on screen with a
 * field name nobody has seen in it, and nothing on the page would say it was invented. A raw line at least says
 * "here is what the harness wrote". Capture one run each, the way codex's was captured, then extend these three.
 *
 * Which means their tool calls show as raw JSON today. That is the honest state and it is not the finished one.
 */
function geminiLine(ev) {
  if (ev.type === "init") return { kind: "head", text: `session ${ev.session_id || "?"}` };
  if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") return { kind: "text", text: oneLine(ev.content) };
  if (ev.type === "result") {
    const ok = ev.status === "success";
    return done(ok, ok ? null : ev.error?.message || ev.status, null);
  }
  return null;
}

function opencodeLine(ev) {
  if (ev.type === "text" && ev.part?.text) return { kind: "text", text: oneLine(ev.part.text) };
  if (ev.type === "step_finish") {
    const reason = ev.part?.reason ?? null;
    return done(reason === "stop", reason === "stop" ? null : `turn ended with reason "${reason}"`, ev.part?.cost);
  }
  if (ev.type === "error") return done(false, ev.error?.message || ev.message || "error", null);
  return null;
}

function gooseLine(ev) {
  // goose splits one assistant reply across several `message` events, as lib/harness.mjs records, so a row per
  // event would be a row per fragment. The fragments are joined into prose and only a whole-looking one is shown.
  if (ev.type === "message" && ev.message?.role === "assistant") {
    const t = (ev.message.content || []).filter(b => b?.type === "text").map(b => b.text).join("").trim();
    return t ? { kind: "text", text: oneLine(t) } : null;
  }
  if (ev.type === "complete") return done(true, null, ev.cost_usd);
  if (ev.type === "error") return done(false, ev.error?.message || ev.message || "error", null);
  return null;
}

/** One reader per harness, keyed by the same names lib/harness.mjs's `adapters` uses. */
export const readers = {
  claude: claudeLine,
  codex: codexLine,
  gemini: geminiLine,
  opencode: opencodeLine,
  goose: gooseLine,
};

/**
 * One log line for `harness`, as { kind, tool, arg }, a list of those, or null.
 *
 * null means "render the line as itself, escaped": a line that is not JSON at all (the runner's own output, a
 * harness writing to stderr, a crash message), or an event this harness's reader does not claim. Never blank, because
 * a line nobody can read is still evidence and the pane is the only place it is ever seen.
 *
 * `{ kind: "skip" }` is the one exception, and it is the opposite case: an event the reader DOES recognise and whose
 * content is not news, which today means a tool result that succeeded. Dropping that is a decision, not a failure.
 *
 * `{ kind: "beat" }` is the third answer: an event that belongs on a row the pane already drew. A heartbeat for a
 * call still running is not a new line and it is not nothing either, so it names the row it updates and the renderer
 * rewrites that row rather than appending.
 */
export function harnessLine(harness, line) {
  const read = readers[harness];
  if (!read) return null;
  let ev = null;
  try { ev = JSON.parse(line); } catch { return null; }
  if (!ev || typeof ev !== "object") return null;
  const out = read(ev);
  if (!out) return null;
  // A reader may answer with one row or, when an event carried several, a list of them. Toning is the same either way.
  for (const row of Array.isArray(out) ? out : [out]) if (row.kind === "tool" && !row.tone) row.tone = TONE[row.tool] || "";
  return out;
}

/**
 * Which tools are worth colouring apart. command-center's TOOL_KIND, with the rows Gallivant's own stream adds:
 * `hook`, `task`, `limits` and `system` are bookkeeping and read as meta; ERROR is not a tool at all and is toned
 * by the reader that produced it.
 */
export const TONE = {
  WebSearch: "search", WebFetch: "fetch", Read: "read", Write: "write", Edit: "write",
  Bash: "shell", Agent: "agent", Task: "agent", ToolSearch: "meta", ListAgents: "meta",
  SendMessage: "meta", Monitor: "meta", Glob: "read", Grep: "read",
  hook: "meta", task: "meta", limits: "meta", system: "meta",
};
