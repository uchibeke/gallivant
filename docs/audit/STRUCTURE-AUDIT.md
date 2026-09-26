# Structure audit: DRY and separation of concerns

Audited against the working tree at `6a7627b4ec8b261743aab108b8c395910f79b536` on `feat/v0.1`, including
uncommitted changes to `tick.mjs`, `events.mjs`, `gh.mjs`, `deliverable.mjs`, `prd.mjs`, `up.mjs` and
`register.mjs` that landed while this ran. 244/244 tests passing at the last run (they added tests with those fixes). Another agent is still
editing, so every site below was re-read after their changes; re-check anything that looks off.

One item that was on this list is already fixed by that agent: `register` and `reconcile` each had their own
copy of the PRD-snapshot fetch, and both now call `ensurePrdSnapshot` in `prd.mjs`. Finding 11 below is what
that consolidation left behind.

Read every file under `lib/`, `bin/`, and `templates/tracker/`. The boundaries in `docs/architecture.md`
mostly hold. What has accumulated is a handful of formulas written two or three times, and four places
where a harness name or a config decision sits outside the module that owns it.

## Counts

| | |
|---|---|
| Findings | 13 |
| Near-duplicates that have already drifted (a fix in one copy, absent in the other) | 4 |
| The same formula written more than once | 4 |
| Logic outside the module that owns it | 3 |
| Dead exports and vestigial parameters | 3 |
| Comments describing behaviour the code does not have | 2 |
| Boundaries verified clean | 7 |

---

## 1. Three spellings of the handle formula, and the fix is in the two copies, not the original

`lib/state.mjs:20-23` owns it:

```js
export const shortRepo = nameWithOwner => nameWithOwner.split("/")[1];
export const handleFor = (id, entry) => (entry.pr ? `${shortRepo(entry.repo)}#${entry.pr}` : id);
```

Two copies exist:

- `lib/commands/serve.mjs:88` `const handleOf = (id, e) => (e.pr ? `${e.repo.split("/")[1] || e.repo}#${e.pr}` : id);`
- `lib/tracker/runs.mjs:101` `const handleOf = (id, e) => (e?.pr ? `${e.repo?.split("/")[1] || e.repo}#${e.pr}` : id);`

The two tracker copies carry a fix the canonical one does not: `|| e.repo` falls back to the full
`owner/name` when the repo string has no slash, and `runs.mjs` also guards `e?.` and `e.repo?.`
for a run folder whose entry was removed from the registry. `handleFor` in `state.mjs` would throw on
`undefined.split` in exactly that case, which is the case `runs.mjs:95` is written to survive.

So the fix went into the copies and not the original. `status.mjs:14` and `tick.mjs:53` (the notification
title, and the `gallivant why <handle>` hint inside it) both call the unguarded `handleFor`. Verified against
the current `state.mjs`:

- `handleFor("a/b/c", { pr: 3, repo: "widget" })` returns the string `"undefined#3"`. An entry whose `repo` was stored without an owner puts `undefined#3` in the ntfy title and in the `gallivant why undefined#3` the body tells the operator to run. The tracker shows `widget#3` for the same entry.
- `handleFor("a/b/c", { pr: 3 })` throws `Cannot read properties of undefined (reading 'split')`. In `tick.mjs:53` that is inside `needsHuman`, so an entry with no `repo` throws after the state was already written to `needs-human` and after the labels were pushed, but before the notification goes out. `tickEntry`'s caller catches it per entry (`tick.mjs:373`), so the daemon survives and the operator is never told the PR stopped. The tracker lists it fine.

`shortRepo` has a third caller that is not `handleFor` at all: `lib/notify.mjs:14,19` builds both message
titles from it directly, so the ntfy title says `undefined#3` even where the handle in the body is fine.
Fixing `shortRepo` fixes all three.

Neither case is exotic: `newEntry` lowercases `repo` but nothing rejects a repo without a slash, and
`register.mjs:27` falls back to `parsed.repo` from a URL regex. The tracker survives both because the copies
were hardened; the notification path was not.

**Consolidation.** Move the guards into `state.mjs:handleFor`:

```js
export const shortRepo = nameWithOwner => String(nameWithOwner || "").split("/")[1] || nameWithOwner || "";
export const handleFor = (id, entry) => (entry?.pr ? `${shortRepo(entry.repo)}#${entry.pr}` : id);
```

then delete both `handleOf` definitions and import `handleFor`. `runs.mjs` already imports `idSlug` from
`state.mjs`, so the import costs nothing. Keep the guarded spelling: it is the one that has met a real
registry with a hole in it.

## 2. The liveness check is written three times, and the third copy has lost the pid-reuse fix

`lib/run.mjs:19-25` is the only correct one. Its whole reason for existing is the comment above it: after a
daemon crash the exit is never recorded, and days later the same pid belongs to a stranger, so a run counts
as live only when `ps` still shows the harness binary.

- `lib/run.mjs:39` `running = job => !!job && job.exit === null && !!job.pid && probe(job.pid, job.bin)`. Correct.
- `lib/commands/serve.mjs:34` `liveness = job => !!job && job.exit === null && isOurProcess(job.pid, job.bin)`. Same answer, reimplemented, and it dropped the `!!job.pid` guard. Harmless as it stands (`process.kill(null, 0)` throws `ERR_INVALID_ARG_TYPE`, `alive` catches it and returns false), but the guard is the reason `run.mjs` reads correctly on its own, and dropping it makes correctness depend on a `catch` two calls away.
- `lib/commands/serve.mjs:145` `isRunning: job => !!job && job.exit === null && alive(job.pid)`. **This is the drift.** It uses `alive` instead of `isOurProcess`, so the pid-reuse fix is absent on this one path.

That third copy is the `?source=` branch of `GET /api/run/output`, the SSE stream for a run in a configured
flat tree. Concretely: a foreign run whose daemon died without recording an exit, whose pid has since been
reused by any unrelated process, streams forever. `stream.mjs:67` re-asks `isRunning` on every tick and
never closes, so the browser holds an open EventSource, the one-second `setInterval` and the 20-second
keepalive run for the life of the server, and the pane says "connecting" on a run that ended days ago.
Every other route on the same file got `liveness`; this line did not.

**Consolidation.** Export the predicate from `run.mjs`, where `isOurProcess` and its reasoning already live:

```js
export const jobRunning = job => !!job && job.exit === null && !!job.pid && isOurProcess(job.pid, job.bin);
```

Have `makeRunner`'s internal `running` use it, import it in `serve.mjs` as the only `isRunning` any route
passes, and delete both `serve.mjs` spellings. The `alive` export stays for `up.mjs:20`'s daemon-pid check,
which is a different question (is the daemon there) with a different correct answer.

## 3. `doctor` validates a config assembled against the wrong home

`lib/config.mjs:186-191`, `load`:

```js
const cfg = merge(raw, home);
const problems = validate(cfg, home);
```

`lib/commands/doctor.mjs:79`:

```js
const problems = validate(merge(raw), home);
```

`merge(raw)` with no second argument defaults to `gallivantHome()`, which reads `$GALLIVANT_HOME` or
`~/.gallivant`. `validate` then gets the caller's `home`. When they differ, and `config.json` names no
`harness` key so `merge` falls through to `discoverHarnesses(home)` at `config.mjs:148`, the discovered
`harness.claude.settings` is built from the default home (`config.mjs:35`, `join(home, "claude", "settings.json")`)
while every check below it uses the passed `home`.

The cost is specific. `doctor({ home })` is the entry point the tests and any second instance use, and
`doctor.mjs:137` reads `config.harness.claude.settings` to check the settings file, the APort hook and the
passport. Against a non-default home with no explicit `harness` key, those three checks report on a path in
the wrong directory: the settings file "missing" when it is there, or worse, "ok" against another instance's
file. `load` got this right; `doctor` is the second caller and was not updated with it.

**Consolidation.** One character: `validate(merge(raw, home), home)`. Both spellings should just be
`merge(raw, home)`; there is no caller for whom the default is what it wants.

## 4. Four places outside `harness.mjs` name a harness

`docs/architecture.md:12` and the comment at `lib/harness.mjs:56` both say it: "Nothing else names a harness."
Four places do.

1. **`lib/config.mjs:10`** `export const HARNESSES = ["claude", "codex", "gemini", "opencode", "goose"];`
   This is `Object.keys(adapters)` written out by hand. `harness.mjs:56` says adding a harness means "a new
   entry in this object, a name in HARNESSES, and its own tests", so the second list is acknowledged, but it
   is still a second list that can disagree. It feeds `block.mjs:11` (`RULES.harness`), `prd.mjs:13,156,158`
   (the frontmatter rule and its message) and `config.mjs:174-176`. A harness added to `adapters` and not to
   `HARNESSES` passes `adapterFor` and is then rejected by `parseBlock`, which means recovery drops the PR at
   `up.mjs:45` with "invalid harness". Import order forbids `config.mjs` importing `harness.mjs`
   (`harness.mjs` does not import `config.mjs`, so the dependency is available): move `HARNESSES` to
   `harness.mjs` as `export const HARNESSES = Object.freeze(Object.keys(adapters))` and re-export it from
   `config.mjs` for the existing importers. One list, derived.

2. **`lib/config.mjs:34-35`** `out[name] = name === "claude" ? { bin, settings: ... } : { bin };`
   Whether a harness takes a settings file is per-harness knowledge. The comment even states the rule ("Only
   Claude takes a settings file; the other four are configured by flags and env in the adapter"), which is a
   fact about the adapters written in the config module. `config.mjs:178` repeats the same condition in
   `validate`, and `buildRun` at `harness.mjs:309,312` consumes `h.settings` generically. Give the adapter a
   flag (`settings: true` on claude, absent elsewhere) and both sites read `adapterFor(name).settings`.

3. **`lib/commands/doctor.mjs:120`**
   ```js
   return r.ok ? ok() : fail(r.detail, h === "claude" ? "claude auth login" : "codex login");
   ```
   This loops over *every* configured harness. A gemini, opencode or goose install that is signed out is told
   to run `codex login`. That is a wrong instruction printed as the fix, in the one command whose entire
   purpose is printing the right fix. Each adapter already has its `signIn` descriptor at `harness.mjs:78,100,140,183,231`;
   add the instruction next to it (`signIn.fix`) and read it here. This is a bug, not just a boundary
   violation, and it costs the operator of three of the five supported harnesses a wrong command.

4. **`lib/commands/register.mjs:37`** and **`lib/prd.mjs:110,158,212`** default to the string `"claude"`.
   `register.mjs:38` `harness || existing?.harness || block?.harness || "claude"` and `prd.mjs:110`
   `harness: meta.harness || "claude"` both mean "the default harness", which is a fact about the harness set.
   A single-harness install with only goose on the PATH gets `discoverHarnesses` returning `{ goose }`, then
   `register` with no `--harness` picks `"claude"` and fails at `register.mjs:39` with `harness "claude" is
   not configured`. A `DEFAULT_HARNESS` in `harness.mjs`, or better, falling back to the first configured
   harness, removes the failure and the duplication together. `prd.mjs:212` (`withStatus` adding a default
   harness to a file with no frontmatter) has the same shape.

## 5. `block.mjs`'s session rule only accepts two of the five harnesses' session ids

`lib/block.mjs:12`:

```js
session: v => v === "none" || /^[0-9a-f]{8}-[0-9a-f]{4}-...-[0-9a-f]{12}$/i.test(v),
```

That is a bare UUID, which is what `claude` and `gemini` mint (`harness.mjs:59,124` `randomUUID()`).
The other three do not:

- `goose` (`harness.mjs:201`) mints `gallivant-<uuid>`.
- `opencode` (`harness.mjs:165`) reads back `ses_f25fcd907ffesl1i92jsR2lh9I` off the run.
- `codex` (`harness.mjs:91`) reads back a `thread_id`, whose shape this codebase never pins down.

The block is the identity of record. `register.mjs:49-52` says so explicitly: "reconciliation rebuilds an
entry from the block alone after `state.json` is lost". So for a goose, opencode or codex entry:
`register.mjs:59` writes a block whose session field `parseBlock` will refuse, and `up.mjs:46-47` then logs
`invalid session: ...` and **ignores the PR**. Lose `state.json` with a goose entry watched, and recovery
silently drops it. The tick writes the same block at `tick.mjs:143`, with the same result.

This is the highest-cost finding here, because it is a whole-harness feature (three of the five) defeated by
a validation rule in a module that should not know session shapes at all. It is invisible until a registry is
lost, which is exactly when it matters.

**Consolidation.** The knowledge belongs in the adapter. Add a `sessionOk` predicate (or reuse the existing
`newSession` shape) per adapter and have `RULES.session` dispatch on the block's already-parsed `harness`
field. `parseBlock` validates `harness` first, so the harness is available before `session` is checked; make
the loop at `block.mjs:32` order-sensitive or validate `session` after the loop. Failing that, a permissive
`/^[\w.-]{8,128}$/` is strictly better than today: it still refuses injected markup and newlines, which is
what the strictness was for ("on a public repo anyone can edit a PR body"), without refusing three harnesses.

## 6. `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.aport` and the home are listed twice, in two orders

- `lib/config.mjs:96-102`, the `forbidden` array inside `validateContextPaths`: `[home, ~/.claude, ~/.codex, ~/.config/opencode, ~/.aport]`, each paired with a human label.
- `lib/commands/doctor.mjs:19`, `CONTROL_PLANE`: `["~/.claude", "~/.codex", "~/.config/opencode", "~/.gallivant", "~/.aport"]`.

Same five directories, two hand-maintained lists. `CONTROL_PLANE` drives `passportGaps` (the passport's
`blocked_paths` check) and the fix text at `doctor.mjs:154,275`; the config list refuses a `context_paths`
entry that would contain one. They answer the same question, "which directories bound a run", and a sixth
directory added to one is missing from the other. `doctor.mjs` spells the Gallivant home as the literal
`~/.gallivant` where the config list uses the actual `home`, so a `$GALLIVANT_HOME` install has a passport
check that names the wrong directory.

**Consolidation.** Export one list from `config.mjs`, since it already owns path validation:

```js
export const controlPlane = (home = gallivantHome()) => [
  [home, "the Gallivant home"], [expand("~/.claude"), "~/.claude"], ...
];
```

`validateContextPaths` keeps the labels; `doctor` maps to bare paths. Keep `config.mjs`'s spelling: it
resolves the home rather than assuming it.

## 7. `start` and the tick spawn a run through two different code paths

`lib/tick.mjs:99-109` (`startRun`) and `lib/commands/start.mjs:54-61` do the same four steps: pick the
adapter, mint or reuse a session, resolve the context paths, `buildRun`, then `runnerFor(id).start(name,
spec.cmd, spec.args, { cwd, env: { ...runEnv(config), ...spec.env } })`.

The tick's copy has a guard the `start` copy does not. `tick.mjs:197-203` catches a `buildRun` throw whose
message matches `/context_paths/` and stops the entry with reason `context-paths`, because "a harness that
refuses the configured context_paths will refuse identically on every tick". `start.mjs:60` has no such
catch: `buildRun` throws out of `start`, which is arguably right for a one-shot CLI command (the operator
sees the error), but note what has already happened by line 60. `writePrd` at :45 wrote the snapshot,
`git.create` at :48 cloned the repository, `writeText` at :53 wrote the brief into it. Nothing is rolled
back and nothing is in the registry, so the operator gets the refusal message and a stray worktree that
`git.create` will refuse to reuse on the next attempt (`git.mjs:37`, "worktree already exists"). `start`
already runs a sign-in probe at :41 for exactly this reason ("Nothing is recorded for a harness that is
signed out"); the `context_paths` refusal is knowable just as early and is not checked.

**Consolidation.** Two options, both small. Either hoist the spawn into a shared helper that both call (it
is genuinely the same five lines, with `name`, `mode` and `session` as the only variables), or, cheaper and
more valuable, call `contextSupport(request.harness)` in `start` alongside the sign-in probe at :41 and
refuse before the clone. `contextSupport` (`harness.mjs:288`) already exists and already returns the refusal
text; `doctor.mjs:127-131` is its only caller today.

## 8. The run-folder layout is re-read in three places

`lib/tracker/runs.mjs:44-45`:

```js
const readJob = dir => { try { return JSON.parse(readFileSync(join(dir, "job.json"), "utf8")); } catch { return null; } };
```

`lib/tracker/stream.mjs:14-15`:

```js
const linesOf = dir => { try { return readFileSync(join(dir, "job.log"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
const jobOf = dir => { try { return JSON.parse(readFileSync(join(dir, "job.json"), "utf8")); } catch { return null; } };
```

`lib/run.mjs:36-38` has both again, keyed by run id rather than by directory:

```js
const read = id => { try { return JSON.parse(readFileSync(join(dirOf(id), "job.json"), "utf8")); } catch { return null; } };
const lines = id => { try { return readFileSync(join(dirOf(id), "job.log"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
```

Three copies of "read job.json, null on failure" and two of "read job.log as non-empty lines". The run
folder layout (`job.json`, `job.log`, those field names) is `run.mjs`'s knowledge; the comment at
`runs.mjs:6-9` says as much, then reimplements it anyway.

The cost is low today because the shape is two lines and stable. It is worth noting rather than ranking high:
`run.mjs`'s copies are the ones with a validated id in the path (`dirOf` enforces `[A-Za-z0-9_-]`), the
tracker's take a directory built elsewhere. Exporting `jobIn(dir)` and `linesIn(dir)` from `run.mjs` and
having `dirOf`-keyed `read`/`lines` call them would make the layout knowledge live in one file without
weakening the id check. Not urgent; flagged because a change to the log format has to find five sites.

## 9. Dead exports: three, one of which is a second spelling of a live rule

- **`lib/prd.mjs:34`** `REQUIRED_SECTIONS = ["Problem", "User stories", "Acceptance criteria", "Verify", "Where to look", "Out of scope"]`. Nothing imports it, in `lib/`, `bin/`, `test/` or `docs/`. It is the same six section names that `check()` hardcodes one at a time at `prd.mjs:164,169,174,179,183,185`. Two spellings of the required-section list, one of them unread, which is the exact shape of a stale constant: an operator or an agent editing `REQUIRED_SECTIONS` to add a section changes nothing.
- **`lib/sources/index.mjs:18`** `adapterOfKind`. No importer anywhere. Written for the second source that the file's own comment says does not exist.
- **`lib/sources/prd.mjs:48`** `fileOf`. No importer anywhere. `renderCheck` (`prd.mjs:196`) uses `prd.id` directly, which is the thing `fileOf` was meant to replace "for messages that name the file rather than the id".

Delete all three. `adapterOfKind` and `fileOf` are cheap to re-add when a second source arrives;
`REQUIRED_SECTIONS` should be deleted or made live (have `check` iterate it), not left as a decorative list.

## 10. `ctx.clock` is a parameter nothing sets

`lib/commands/serve.mjs:93`:

```js
"GET /": (ctx, _req, res, url, v) => html(res, 200, dashboard(model(ctx), { clock: ctx.clock, ...v })),
```

`makeContext` (`lib/context.mjs:22-32`) never sets `clock`. It is `undefined` on every real request, which
`dashboard`'s `{ clock = Date }` default absorbs, so nothing is broken. It is threaded only because the
tests set it. Two of the three page renderers do not take it at all (`runPage`, `runsPage` call `ago` and
`when` with no clock), so a test that moves time forward sees a moved clock on the dashboard and a real
clock on the other two pages. Either put `clock` in `makeContext` (`clock: Date`) so the name is honest and
pass it to all three renderers, or drop it from this line and let the tests stub `Date`. Today it is a
parameter that claims an injection point the context does not have.

## 11. The newly shared `ensurePrdSnapshot` is guarded in one caller and not the other

`lib/prd.mjs:224` is the consolidation of what `register` and `reconcile` each used to do inline. Good change.
The two callers now disagree about failure:

- `lib/commands/register.mjs:87` `await ensurePrdSnapshot(...).catch(e => log.warn(...))`, with four lines of comment explaining exactly why: "a GitHub read that fails leaves a watched PR rather than an aborted registration".
- `lib/commands/up.mjs:52` `await ensurePrdSnapshot(ctx, { id, repo, path: block.prd, ref: pr.headRefName });` with no catch.

`gh.fileAt` already swallows its own errors (`gh.mjs:93-95`, `.catch(() => null)`), so the remaining throw is
`writePrd`, which is `writeText` (`fs.mjs:76`) and so `ensureDir` plus `writeFileSync`: a full disk, a
read-only home, a permissions problem. In `register` that is a warning on a PR that is already registered. In
`reconcile` it propagates: `up.mjs:83` calls `reconcile` **outside** the `try` that `loop` wraps at
`up.mjs:91`, so the throw leaves `up()`, reaches `bin/gallivant.mjs:75`, and the daemon prints `error: ...`
and exits. One unwritable snapshot on one recovered PR takes the whole daemon down before it ticks once, and
the operator sees a filesystem message with no mention of which PR or that recovery was the step.

The reasoning for the guard is already written above the `register` call; it applies with more force to
`reconcile`, which is walking every PR in every configured repo and should skip the one it cannot snapshot,
exactly as it already skips a PR with a bad block (`up.mjs:47`) or a duplicate id (`up.mjs:51`). Add the same
`.catch(e => log.warn(...))`, or move the guard inside `ensurePrdSnapshot` so neither caller has to remember
it. The second is better: the function already decides that a missing file is "not fatal" and logs rather than
throws for it (`prd.mjs:228`), so an unwritable snapshot being fatal is an inconsistency inside one function's
own contract.

## 12. `templates/tracker/tracker.js` comments describe command-center, not Gallivant

Three comments describe a runner Gallivant does not have:

- **`:151`** "Tool calls arrive indented by the harness reducer in lib/harness.mjs: `  WebSearch: quiet hotels in Lisbon`." There is no reducer in `harness.mjs`. Its `outcome` and `sessionFrom` parse JSONL and return objects; nothing writes indented `Tool: arg` lines. Gallivant's `job.log` is the harness's own stdout, redirected by `run.mjs:49` (`stdio: ["ignore", out, out]`), which for every adapter is `stream-json`/`--json` JSONL.
- **`:153`** "A terminal line the runner appends: `done in 42s (harness exit 0)`". `run.mjs` appends nothing to `job.log`. It writes `job.json` and `cmd.json`; the log file only ever receives child output. `grep` over the whole repo finds `done in ` only in this file and in `test/tracker.test.mjs:361`, which calls `renderLine` directly.
- **`:155`** "The runner's own opening line, written by lib/harness_run.mjs". **`lib/harness_run.mjs` does not exist** in this repository.

`docs/architecture.md:69` says the port is deliberate and that "a fix to those regexes belongs in both
copies", which makes keeping the `TOOL`, `DONE` and `HEAD` regexes correct. The comments are a separate
matter: they name a Gallivant file that does not exist and a Gallivant behaviour that does not happen, so a
reader debugging why a log line rendered as prose goes looking in `harness.mjs` for a reducer. Rewrite the
three to say what is true: these branches are command-center's line shapes, kept so the parse stays
identical across the two copies, and they do not fire on a Gallivant run.

## 13. `config.mjs:90`'s comment claims a symmetry the code does not implement

`lib/config.mjs:88-90`:

> A run that can read the Gallivant home or `~/.claude` can read the settings file that bounds it [...]
> A parent of any of those directories is refused for the same reason a child would be pointless to refuse.

The code (`config.mjs:111`) checks `isInside(dir, p)`: the forbidden directory inside the candidate, so a
parent is refused. A child is not, and `validateContextPaths(["~/.claude/plugins"])` returns `[]` today.
The comment's last clause asserts that refusing a child would be "pointless", which is the argument for the
asymmetry, and for `~/.claude/plugins` it holds. It does not hold for every child: `~/.claude/settings.json`'s
directory is `~/.claude` itself, so that case is covered, but `~/.aport/<agent>/` holds passport material and
is accepted. Worth a second look by whoever owns the guardrail story. Flagged as a comment/code mismatch
rather than a defect, because the stance may be intended; if it is, say which children are safe and why,
since "pointless to refuse" reads as "all of them".

---

## Boundaries verified clean

- **`lib/gh.mjs` is the only module that runs `gh`.** Every GitHub read and write in `lib/` goes through an injected `gh`. The two other `gh` invocations are `git.mjs:31,39,58` (`gh repo clone`, for a clone, not an API call) and `doctor.mjs:193` (a `gh api` command printed as fix text, never executed). `doctor.mjs:75,89` build their own `makeGh` rather than reaching past it.
- **`lib/events.mjs` is pure.** No imports beyond `gh.mjs`'s pure helpers and `time.mjs`. No event-qualification logic leaked into the tick: `deriveEvents`, `reviewerVerdict`, `isGreen`, `countRounds` and `hasOwnComment` are all called from `tickEntry`, none reimplemented there. `tick.mjs:227` (`checksSettled`) is the one judgement in the tick, and it is orchestration, not qualification: it asks GitHub for a commit date, which a pure function cannot do.
- **Nothing under `lib/tracker/` writes to disk.** Confirmed by reading all four files: `readFileSync`, `readdirSync` and `fs.watch` only.
- **The tick is the only writer during a daemon run.** `state.update` and `state.put` appear in `tick.mjs`, and otherwise only in `start.mjs:64`, `register.mjs:81`, `up.mjs:56` and `bin/gallivant.mjs:70`, all CLI-initiated before or outside a tick. No write in an exit handler, timer or callback: `run.mjs:51,53`'s `p.on` handlers write `job.json`, which is the runner's own file, not the registry.
- **Cursor advancement goes through one function.** `advanceCursor` (`state.mjs:105`) is the only place `since` and `dispatched` move together, and both tick sites use it. The four hand-built `cursor: {...}` literals (`state.mjs:123`, `tick.mjs:147`, `register.mjs:76`, `up.mjs:59`) all set a fresh cursor with `dispatched: []`, which is initialisation rather than advancement, and each sources `since` from a GitHub timestamp (already second-precision) or from an explicitly floored `nowIso()`. No missing `floorSecond`.
- **Path expansion is in one place.** `expand` (`fs.mjs:26`) is the only `~` handler, and `config.mjs:192-199` (`load`) is the only place config paths are expanded. `resolveContextPaths` re-validates frontmatter entries rather than trusting them, which is the fix for the recovery path and it is in the shared function, not in a caller.
- **Prompt quoting is in one place.** `quote` (`prompt.mjs:8`) with its `MAX_QUOTE` cap; `deliverable.mjs:208` imports it for the denial text rather than writing its own. Every path that puts GitHub or agent text into a prompt goes through it.
