# Pre-review audit: the defects round five would find

Audited 2026-09-26 against the working tree at `/Users/uchi/Downloads/projects/gallivant`, branch `feat/v0.1`,
HEAD `6a7627b` plus uncommitted changes. Read-only: nothing in the repository was changed.

Another agent was editing `lib/tick.mjs`, `lib/events.mjs`, `lib/gh.mjs`, `lib/deliverable.mjs`, `lib/prd.mjs`,
`lib/harness.mjs`, `lib/block.mjs`, `lib/commands/up.mjs` and `lib/commands/register.mjs` throughout. Two findings that
were live when this opened were fixed under it and are recorded in the "fixed while this was written" section rather
than as defects; two more (F7, F8) are in code that appeared during it. Line numbers were re-checked against the tree
on the last read and every one resolves, but the tree is still moving, so check the symbol rather than the number if a
citation looks off by a line or two.

Method: each finding was reproduced by driving `makeTick` or the pure functions with `test/helpers.mjs` fakes and
printing the resulting registry entry, the GitHub calls and the log. The traces quoted below are actual output. A claim
with no failing run is not in this document; three things that looked like defects on reading turned out to be sound
when driven and are recorded under the invariants instead.

## Summary

| Severity | Count | Findings |
|---|---|---|
| Critical | 1 | F1 |
| Major | 7 | F2, F3, F4, F5, F6, F7, F8 |
| Minor | 4 | F9, F10, F11, F12 |

The four rounds before this one found fail-open defaults, timestamp precision, state transitions that skip a check,
swallowed writes and crash loops. All five classes still have live instances. The two that matter most are a cursor
that can move backwards (F1, which also double-dispatches and burns a round in one pass) and a completion gate that
evaluates nothing when the brief it reads has no acceptance criteria (F2).

By class, so the pattern is visible:

| Class | Findings |
|---|---|
| Fail-open on an absent value or an error | F2, F3, F5 |
| Timestamp precision or ordering | F1, F7 |
| A state transition that skips a check | F1, F6, F9 |
| A best-effort write after the state moved | F12 |
| A crash or a stall loop with no diagnosable stop | F4, F6, F9 |
| A stop fired for a reason that is not true of the entry | F6, F7 |
| A refusal that does not refuse what it names | F8, F11 |
| A round counted with no progress | F5, F1 |
| The loop feeding itself | F10 |

F7 and F8 are in code that changed during this audit, which is the pattern the brief describes: each round's findings
are consequences of the previous round's fixes. They are reported as findings, not as complaints about work in flight.

The whole suite passes as of this read (246 tests, 0 failures), so none of these is a state the project already knows
about. Each one is a gap in the tests as much as in the code, and F3 is worse than a gap: six fixtures assert the
behaviour it breaks and none of them exercises it.

---

## F1. Critical. A round whose new head has an older commit date drags the cursor backwards, dispatches the same feedback twice, and burns a round

`lib/tick.mjs:165` (the `since` the push round writes) and `lib/tick.mjs:169` (`advanceCursor` with no floor).

`settleRun` sets the post-push cursor to the head commit's committer date, whatever that date is:

```js
const since = floorSecond(pushed ? await headPushedAt(entry, pr.headRefOid, now()) : now());
...
cursor: { ...advanceCursor(entry.cursor, since), fixed_sha: pr.headRefOid, receipt_hash: hash },
...(pushed ? { rereview: { at: since, nudged: false } } : {}),
```

Nothing constrains `since` to be at or after `entry.cursor.since`. The events path does exactly that guard one screen
down (`since: later(newest, entry.cursor.since)`, line 267); this path does not. `advanceCursor` then sees a different
instant and clears `dispatched`, which is the only thing that stops an event at the cursor's own second being sent
again.

Scenario, run against the tree:

- Entry `acme/widget/widget-export`, `pr-open`, `iteration: 1`, `cursor.since = 02:20:00Z`,
  `cursor.dispatched = ["review:2201"]`, `cursor.fixed_sha = a1b2c3`, `rereview.at = 02:20:00Z`,
  `last = { run: "1-fix", exit: null, event: "review 2201 by chatgpt-codex-connector" }`.
- The reviewer's `CHANGES_REQUESTED` review 2201 is on the PR, stamped 02:20:00Z. It is the review that started the
  round and it is recorded in `dispatched`.
- The fix run ends. It reset the branch and force-pushed: the head is now `OLDHEAD`, whose committer date is
  02:02:00Z. `gh.commitDate` reports 02:02:00Z, which is what it is for.
- Local time 02:25:00Z. One tick.

What happens, from the trace:

```
I:widget/widget-export: round 2 pushed, re-review requested
I:widget/widget-export: dispatched (review 2201 by chatgpt-codex-connector)
runs: [ 'fix', 'fix' ]
rereview: { at: '2026-09-24T02:02:00.000Z', nudged: false }
iteration: 2
```

Three things go wrong in one pass:

1. `cursor.since` moves from 02:20 to 02:02, eighteen minutes backwards, and `dispatched` is emptied.
2. `tickEntry` continues in the same pass, re-derives events against the regressed cursor, and review 2201 is a new
   event again. A **second** fix run is spawned for the review the first one just handled. The real runner does not
   stop this: the previous run has an exit recorded, so `start` does not throw `BUSY`.
3. `iteration` becomes 2 for a push that removed work, and `rereview.at` is left at 02:02, so the nudge and the
   `stall_hours` stop are both measured from eighteen minutes in the past. The nudge fired in the same tick.

Force-push is forbidden in the prompt (`lib/prompt.mjs:16`), which is prose to a language model and not a control.
A branch protection ruleset would stop it, but `doctor`'s ruleset check does not require force-push protection, and
an entry on a repo without one reaches this. The same regression happens on the receipt path
(`lib/tick.mjs:319`, `since: readAt`, where `readAt = floorSecond(now())`): any clock behind GitHub's by a second or
more moves the cursor back and clears `dispatched`. That variant was also reproduced.

The invariant the code states in its own header comment, that the cursor never goes backwards, has two writers that
can violate it. The fix is the same guard the events path already uses: `later(candidate, entry.cursor.since)` at
both sites.

---

## F2. Major. The completion gate passes with nothing evaluated when the brief it reads has no acceptance criteria

`lib/deliverable.mjs:44` (`criteriaFromPrd`), `lib/deliverable.mjs:95-102` (`evaluate`), `lib/tick.mjs:305`.

`criteriaFromPrd` maps the `Acceptance criteria` section's bullets to criteria. A brief with no such section yields
`[]`. Every rule in `evaluate` that depends on the criteria then passes vacuously: `missing` is empty because there
is nothing to be missing, `unknown` is empty, `notMet` and `noEvidence` are empty because there are no attestations.
What is left is the summary word count and `tests_passing`, both of which a green PR with a wordy receipt satisfies.

Scenario, run against the tree:

- Snapshot on disk for the entry: `---\nstatus: ready\nharness: claude\n---\n\n# A brief with no criteria section\n\n## Problem\n\nnothing\n`.
- PR body carries a receipt whose `criteria_attestations` is `[]` and whose `summary` is 25 words.
- Checks green, reviewer clear, `deliverable.evaluator: "local"`.

Result: `completion gate passed (local)`, `state: ready-for-human`, `notify.ready` fired. Zero acceptance criteria
were evaluated and the operator is told a human can merge it.

The reachable path is the recovery seam, not `start`. `start` runs the contract, which requires the section, so a
brief that starts cannot look like this. But `ensurePrdSnapshot` (`lib/prd.mjs:229`, called from `reconcile` at
`lib/commands/up.mjs:46` and from `register` at `lib/commands/register.mjs:86`) takes the snapshot from the PR branch,
and the code says in its own comment that the session could have edited that copy. An agent that deletes or renames
the `## Acceptance criteria` heading in `docs/prds/<id>.md` on its branch, then a daemon restart, produces a gate that
checks nothing on a PR that the same agent wrote. `register` on a hand-made PR reaches it the same way with no agent
involved: point at any PR whose block names a `.md` with no criteria section.

The design intent here is stated clearly ("the PRD the gate reads is the daemon's own snapshot, never the
agent-writable checkout") and the reader path honours it: the only reader is `readPrd` →
`~/.gallivant/prds/<slug>.md` (`lib/context.mjs:30`), never the worktree. What is not honoured is the writer path:
one of the two writers of that snapshot is the agent-writable branch. A snapshot taken from a branch should be held
to the contract before it is trusted as a gate input, or an empty criteria list should be a refusal to decide rather
than an allow.

---

## F3. Major. `reviewerVerdict` clears any head when it cannot tell which commit was reviewed

`lib/events.mjs:145-146`.

```js
const reviewed = reviewedCommit(newest.body) || newest.commit_id;
if (headSha && reviewed && !headSha.startsWith(reviewed) && !reviewed.startsWith(headSha)) return { verdict: "waiting", ... };
```

`reviewed` falsy skips the guard entirely, so the verdict is decided on `newest.state` alone and a review of an old
commit clears the current head. An absent value is read as "nothing to worry about", which is the class the first
round of review already found once in `gh.prDiff`.

Reproduced directly:

```
reviewerVerdict({ reviews: [APPROVED at 02:01, body "Looks good."], headSha: "NEWSHA", sinceIso: T0 })
  -> { verdict: 'clear', note: 'no blocking findings' }
```

The review names no commit and carries no `commit_id`; the head is `NEWSHA`. The answer is `clear`.

`commit_id` is populated on ordinary REST review objects, so the common case is safe. It is null when the reviewed
commit is no longer in the repository, which is what a force-push plus garbage collection produces, and the reviewer
bot's own body is the other half of the guard precisely because the daemon does not want to depend on `commit_id`
alone. When both are absent the answer should be `waiting`, not `clear`: the daemon cannot tell, so it has no
decision.

There is a second half to this, and it is the reason the project's tests do not catch it. `reviewedCommit` requires
7 to 40 hex characters:

```js
const reviewedCommit = body => (String(body || "").match(/Reviewed commit:\*{0,2}\s*`([0-9a-f]{7,40})`/i) || [])[1] ?? null;
```

Every tick and notify fixture uses a 6-character sha:

```
"**Reviewed commit:** `a1b2c3`"  -> null
"**Reviewed commit:** `a1b2c3d`" -> a1b2c3d
```

So `test/tick.test.mjs:8` (`clearReviewer`), `test/tick.test.mjs:160`, `test/tick.test.mjs:184`,
`test/notify.test.mjs:137`, `test/notify.test.mjs:164` and `test/deliverable.test.mjs:112` all read as tests of the
head-match behaviour and are not: the verdict they assert comes out of the fail-open branch, not out of a sha
comparison. `test/events.test.mjs:115` is the only fixture with a 10-character sha and therefore the only place the
guard is exercised at all. This is reported because the test hides the defect, not as a coverage complaint.

---

## F4. Major. A checkout that cannot be recreated retries forever, silently, with no stop and no notification

`lib/tick.mjs:69` (`ensureWorktree`, called at 194), `lib/tick.mjs:201` (`dispatch` rethrows), `lib/tick.mjs:374` (the per-entry catch).

`dispatch` special-cases exactly one throw, the `context_paths` refusal, and turns it into a `needs-human` stop with
a reason. Everything else propagates to the per-entry catch in `tick`, which logs the message and moves on. The
registry is untouched: the cursor does not move, the state stays `pr-open`, `iteration` does not change, and nothing
is notified. `notify.error` is only ever called from `up`'s probe loop (`lib/commands/up.mjs:88`), never from a tick
failure, so the only trace is a line in `errors.log` and `status`'s `latestError`.

Scenario, run against the tree, with a `git` whose `exists` is false and whose `fromBranch` throws
`fatal: could not read Username`:

```
K3 tick 0 [{"ok":false,"error":"fatal: could not read Username"}] state: pr-open reason: null iteration: 0 runs: 0
K3 tick 1 [{"ok":false,"error":"fatal: could not read Username"}] state: pr-open reason: null iteration: 0 runs: 0
K3 tick 2 [{"ok":false,"error":"fatal: could not read Username"}] state: pr-open reason: null iteration: 0 runs: 0
```

Every `poll_seconds`, forever. Real triggers: an expired or revoked token in `github_token_file` (the `gh`
`authStatus` probe would catch a broken `gh auth`, but not a `github_token_file` that `git` uses and `gh` does not),
a full disk under `worktrees`, a branch deleted on the remote while the entry is still watched, a `worktrees` path
on an unmounted volume. This is the same shape as the malformed-receipt crash loop round four fixed, with a
different input: there, the input was agent-written JSON; here it is the state of the filesystem and the remote.

The fix that matches the existing design is the one `context_paths` already has: a throw from `ensureWorktree`,
or any repeated throw from the same entry, becomes a `needs-human` stop with the cause as the reason, so `gallivant
why` can name it and the phone rings once.

---

## F5. Major. A recovered entry counts a round for a run that changed nothing

`lib/commands/up.mjs:51` (`receipt_hash: null`), consumed at `lib/tick.mjs:159`.

`reconcile` writes `receipt_hash: null` even though `prListMine` fetches the PR body (`lib/gh.mjs:83`) and every other
writer of the cursor sets it from `receiptHash(pr.body)` (`lib/tick.mjs:148`, `lib/tick.mjs:212`,
`lib/commands/register.mjs:75`). `settleRun` then reads it:

```js
const rewrote = !pushed && hash !== null && hash !== entry.cursor.receipt_hash;
```

With `receipt_hash` null and a receipt already in the body, `rewrote` is true for a run that did nothing at all.

Scenario, run against the tree:

- Entry as `reconcile` writes it: `cursor.receipt_hash: null`, `cursor.fixed_sha: a1b2c3`, `iteration: 1`, a fix run
  in flight.
- The PR body already carries a valid receipt (hash `bacb98aeb0c5`). It was there before the recovery.
- The run ends having changed nothing: same head `a1b2c3`, same body.

Result:

```
I:widget/widget-export: round 2 updated the completion receipt
comments posted: ["Completion receipt updated.\n\n<!-- gallivant round -->", ...]
state: pr-open  reason: null  iteration: 2
```

The `no-push` stop that exists for exactly this case does not fire. A round is counted, a comment is posted to the
PR claiming the receipt was updated, and `countRounds` on the next recovery will read that comment back as a real
round, so the miscount is now durable on GitHub. The entry burns its remaining budget this way, one wasted run per
tick-plus-run-duration, until `iterations` stops it for the wrong reason.

`reconcile` should set `receipt_hash: receiptHash(pr.body)` like every other writer. The body is already in hand.

---

## F6. Major. A live run left over from before a reset or a recovery is timed out and blamed on the entry

`lib/tick.mjs:121-130`.

```js
const cur = runner.current();
if (!cur) return false;
if (cur.running) {
  if (clock.now() - cur.startedAt > minutes(config.run_timeout_minutes)) {
    runner.kill(cur.id);
    await needsHuman(id, "timeout", { last: { ...(entry.last || {}), run: cur.id, exit: 137, at: now() } });
  }
  return true;
}
if (entry.last?.run !== cur.id || entry.last?.exit != null) return false;
```

The ownership check is the last line, after the two `return`s. So a run that is still alive and is *not* the run this
entry dispatched short-circuits everything: `settleRun` returns true, `tickEntry` returns, and the entry is frozen.
`run_timeout_minutes` later the leftover is killed and the entry is stopped with `reason: "timeout"`, with
`last.run` overwritten to the leftover's id.

The function's own doc comment says the opposite: "Only the run this entry dispatched (`last.run`) is settled; a
leftover run from before a reset or a recovery is ignored." It is not ignored. It is waited on, then killed, then
blamed.

Scenario, run against the tree:

- Entry `pr-open`, `last = { run: "old-run-that-already-ended", exit: 0, event: "reset by register" }`, which is what
  `register`'s reset leaves behind (`lib/commands/register.mjs:76` keeps `last.run` and its exit on purpose).
- The runner's `current()` is a different run, `1-leftover`, still alive: the session that was going when the
  operator ran `register` to reset the entry.
- A `CHANGES_REQUESTED` review is waiting on the PR.

```
O1 after one tick: state pr-open  reason null  runs 1   logged: []
O1 past timeout:   state needs-human  reason timeout  last.run 1-leftover  killed true
```

For thirty minutes the review is never dispatched and nothing is logged. Then the entry stops for a reason that is
not true of it, and `gallivant why` prints the leftover run's log and cost as though it were this entry's work.

Moving the ownership test above the `cur.running` branch fixes both halves: a leftover run is genuinely ignored, and
the timeout only ever fires on a run this entry started. A leftover process still needs killing, but that is a
different decision from stopping the entry, and it should not borrow this one's reason.

---

## F7. Major. Reopening on a moved head can stop the entry as `reviewer-silent` on the very tick that reopened it

`lib/tick.mjs:285-286`. This is in the head-move reopen added to `tickEntry` during this audit, so it is new ground
rather than a leftover.

```js
const pushedAt = floorSecond(await headPushedAt(entry, pr.headRefOid, now()));
entry = save(id, { state: STATES.prOpen, cursor: { ...entry.cursor, fixed_sha: pr.headRefOid }, rereview: { at: pushedAt, nudged: false } });
```

The comment above it states the intent precisely: the wait "starts now rather than carrying an age that would stop
the entry as `reviewer-silent` on arrival". But the value used is the head commit's **committer date**, not the time
of the push and not now, and nothing floors it. A commit whose committer date is older than `stall_hours` sets a
re-review clock that is already expired, and the `waiting` branch four screens down stops the entry immediately.

Scenario, run against the tree. Entry `ready` on `a1b2c3`. Someone pushes `NEWSHA`, a commit whose committer date is
ten hours ago; `stall_hours` is 6. Checks green, no reviews yet. One tick:

```
I:widget/widget-export: head moved to NEWSHA after ready; watching again
W:widget/widget-export: needs-human (reviewer-silent)
state: needs-human  reason: reviewer-silent  rereview.at: 2026-09-23T16:00:00Z
notify: [["needs", 142, "reviewer-silent"]]
```

The reviewer was given no chance to look at all. The PR is stopped, the phone rings, and the reason names a silence
that never happened. With a committer date between `rereview_minutes` and `stall_hours` the milder version fires: the
nudge is posted on the same tick, before the reviewer has been asked once (reproduced as P2: `nudged: true` and
`@codex review` posted immediately).

Reachable with no force-push and no clock skew. `git commit` on a Monday, `git push` onto the branch on a Thursday,
which is an operator finishing something they started earlier in the week; a `git merge` of an older branch, where
the tip's committer date is the original commit's; any push of a commit that was not created seconds before it left
the machine. Committer date answers "when was this commit made", and the code is asking "when did this arrive on the
branch", which GitHub does not report through `repos/{r}/commits/{sha}`.

`later()` is the wrong fix here because resetting the clock is the point. The right one is a floor on the other side:
`later(pushedAt, <now minus rereview_minutes>)`, or simply `now()`, since this path is not a round of the loop's own
and the reviewer genuinely has not been asked yet.

---

## F8. Major. `register --session` puts an unvalidated string into argv, and `assertSafeArgv` does not catch it

`lib/commands/register.mjs:43` and `lib/commands/register.mjs:73`, with `lib/harness.mjs:279-288`.

`block.mjs` validates a session per harness (`lib/block.mjs:19`, calling each adapter's `isSession`), and the comment
added to `lib/harness.mjs:215` says why goose's in particular matters: "goose derives the session FILE from it, so it
must stay one safe path segment". None of that runs on `--session`. The value is taken as given:

```js
const chosenSession = session || existing?.session || block?.session || null;
...
...base, harness: chosenHarness, session: chosenSession, ...
```

From the registry it reaches argv on the next fix round through `startRun` → `buildRun` → `adapter.resume({ session })`,
where it lands in argv position 2, immediately after `--resume` or `--name`. `assertSafeArgv` then sees it, and its
list is literal spellings:

```
claude   "--permission-mode"      -> ALLOWED  ["--resume","--permission-mode","-p","--permission-mode","auto",...]
claude   "bypassPermissions"      -> ALLOWED
gemini   "--approval-mode=yolo"   -> ALLOWED  ["--skip-trust","--resume","--approval-mode=yolo",...]
goose    "../../../etc/passwd"    -> ALLOWED  ["run","--resume","--name","../../../etc/passwd",...]
claude   "--settings"             -> ALLOWED  ["--resume","--settings","-p",...]
```

`assertSafeArgv` catches `--approval-mode yolo` as two elements and misses `--approval-mode=yolo` as one, which is the
same switch by the other spelling its own doc comment names. It has no rule for a value in a position it does not
expect, so `--resume --settings` shifts every following flag by one and `claude` reads `-p` as the settings path.

Scenario: `gallivant register https://github.com/acme/widget/pull/142 --worktree /path/to/checkout --session
'--approval-mode=yolo'` on a gemini entry. Nothing refuses it: `register` writes it to the registry and to the PR
block, and the next fix round spawns `gemini --skip-trust --resume --approval-mode=yolo ...`. The goose variant writes
goose's session file wherever the path points.

Severity is major rather than critical because the operator types the flag themselves, so this is not a remote input.
It matters anyway for two reasons. The whole point of `assertSafeArgv` is that a flag "cannot arrive from a prompt, a
config value or a future edit to one adapter without passing here first" (its own doc comment), and here is a fourth
source that passes it. And the block path already has the validator this path needs: calling
`adapters[chosenHarness].isSession(session)` in `register` before line 43, and refusing what fails, closes it in one
line and makes the block and the flag agree on what a session is.

While the argv list is open, two spellings worth adding for the same cost: the `=` forms (`--yolo=true`,
`--approval-mode=yolo`) and codex's `--sandbox`/`-s` with a `danger` value, which is the flag spelling of the config
override the value check already refuses.

---

## F9. Minor. A draft PR that is finished is never stopped and never mentioned

`lib/tick.mjs:292` (`!pr.isDraft` gates the ready branch), with nothing downstream that catches the case.

The ready branch requires `!pr.isDraft`. A draft PR that is green with a clear reviewer therefore falls through it,
and then falls through every stop below it as well: `verdict.verdict` is `clear`, so the `blocking` branch does not
fire, the `!green` branch does not fire, and the `waiting` branch (which owns both the nudge and the `stall_hours`
`reviewer-silent` stop) does not fire either. The entry sits in `pr-open` with nothing left to happen to it.

Scenario, run against the tree: a draft PR, one `SUCCESS` check, one `APPROVED` review by the reviewer naming the
head, `rereview.nudged: true`.

```
O3:            state pr-open  notify: []  logged: []
O3 after 8h:   state pr-open  reason null  logged: []
```

Eight hours past `stall_hours`, nothing. `status` reports it in the RUNNING section as `waiting  on reviewer, nudged
once` (`lib/commands/status.mjs:22`, the final `else`), which is not what is happening: the reviewer answered and
cleared it. `SPEC.md:281` says ready requires the PR not be a draft and says nothing about a draft that meets every
other condition, so the code is not contradicting the spec; the spec has a hole and the code falls into it.

Reachable without anything unusual: the start prompt tells the session to run `gh pr create` and does not say
`--draft` is forbidden (`lib/prompt.mjs:26`), and a human marking a ready PR back to draft to think about it reaches
the same place. One `needs-human` with a reason naming the draft, or one log line, is enough.

---

## F10. Minor. The harness's own review comments come back to it as feedback

`lib/events.mjs:74`.

```js
if (c.in_reply_to_id && trust.isOwn(a)) continue;
if (!(trust.isTrusted(a) || trust.isReviewer(a))) continue;
```

The own-login filter is conditional on the comment being a reply. The daemon's login is also the login in
`trusted_authors` on a single-operator install (the design assumes this; `test/helpers.mjs:13` sets
`trusted_authors: ["me"]` with `ownLogin: "me"`), so any inline comment by that login that is *not* a reply passes
the second line and is dispatched.

Scenario, run against the tree. The fix prompt ends with "Reply to each inline thread with one line on what you
changed or why you did not" (`lib/prompt.mjs:77`). A harness that satisfies that with `gh pr review --comment` plus
inline notes, rather than with per-thread replies, produces one `COMMENTED` review by its own login with attached
inline comments, none of which carry `in_reply_to_id`:

```
N1 events: [
  [ 'inline', 11, 'me', 'Did this differently because X.' ],
  [ 'inline', 12, 'me', 'Left this alone, out of scope.' ]
]
```

A bare top-level inline comment by the same login does the same (`N2`). A genuine reply is correctly filtered (`N3`),
which is the case the existing rule was written for.

Next tick those are two new qualifying events, so a fix round is dispatched to answer the harness's own explanation
of its last round. The round budget bounds it (`max_iterations`, then `reason: "iterations"`), so this is a wasted
budget rather than an unbounded loop, which is why it is minor. The correct rule is the one the reviewer half already
uses: an inline comment by the daemon's own login is never feedback, reply or not, because the daemon is the author
of the work.

---

## F11. Minor. `validateContextPaths` is bypassed by a symlink

`lib/config.mjs:125-126`.

The refusals compare lexical paths: `p === homedir()`, and `isInside(dir, p)` (`lib/config.mjs:126`) for the Gallivant home, `~/.claude`,
`~/.codex`, `~/.config/opencode` and `~/.aport`. `expand` resolves `~` and makes the path absolute; it does not
resolve symlinks. So a `context_paths` entry that is a symlink to any of those directories passes every check:

```
symlink to $HOME       -> []   (no problems)
"~" itself             -> ["...is your home directory..."]
symlink to ~/.claude   -> []   (no problems)
```

The comment three lines above states what this must prevent: "a run that can read the Gallivant home or `~/.claude`
can read the settings file that bounds it and the APort passport that audits it; a run that can read `$HOME` can read
every credential on the machine". `SPEC.md:158` repeats the claim that those directories "and any parent of those are
refused". Neither holds through a symlink.

Severity is minor rather than major because reaching it needs either the operator to name a symlinked path in their
own config, or a `context_paths:` key in a brief's frontmatter pointing at one, and the brief author is the operator
today. It becomes major the moment a brief arrives from someone else, which the inbound-contribution work in
`lib/sources/` is heading towards. `realpathSync` on `p` before the comparisons closes it, and the frontmatter list
is already re-validated per run (`lib/config.mjs:147`) so the fix lands on both lists at once.

Related, and worth one line since it is the asymmetry that makes the above worse: `resolveContextPaths` re-validates
the brief's frontmatter list on every run (`lib/config.mjs:147`) but takes the config list on trust from boot
(`lib/config.mjs:141`, comment on 143). A config path that existed at boot and was later deleted or replaced is
handed to `--add-dir` unchecked.

---

## F12. Minor. `needsHuman`'s two-label invariant is stated but not enforced

`lib/tick.mjs:50-51`, with `lib/gh.mjs:106`.

```js
await gh.removeLabel(e.repo, e.pr, READY_LABEL);
await gh.addLabel(e.repo, e.pr, NEEDS_LABEL).catch(err => log.warn(`${id}: label failed: ${err.message}`));
```

`removeLabel` swallows every error unconditionally (`.catch(() => {})` in `gh.mjs`), and `addLabel`'s failure is
logged and dropped. The registry has already moved to `needs-human` by then, and a later tick returns early on
`entry.state === STATES.needsHuman` (`lib/tick.mjs:242`), so neither write is ever retried.

The consequence is the exact contradiction the comment above the function says it exists to prevent: a rate-limited
or briefly unreachable GitHub leaves a PR carrying `gallivant:ready-for-human` and no `gallivant:needs-human`, while
the registry says the entry is stopped. Anything reading labels, a person included, is told the opposite of the
truth, and nothing reconciles it.

Note that the `ready` half of this pair was fixed under this audit: `addLabel` for `READY_LABEL` now refuses to move
the state when the write fails (`lib/tick.mjs:330`), with a comment explaining why. The `needs-human` half has the
same shape and has not had the same treatment. It is minor rather than major because the reason is also carried in
the registry, in `status`, in `why` and in the ntfy message, so the label is not the only signal; a label-driven
automation is the case that breaks.

One more in the same class, worth a line rather than a finding because it fails towards the safe answer. `register`
swallows a snapshot failure (`lib/commands/register.mjs:86`, `.catch(e => log.warn(...))`) with the reasoning written
out: the entry is watched and "the next `reconcile` takes the snapshot instead". That is correct as far as it goes.
What it means in practice is that an entry can be watched indefinitely with no snapshot, and an entry with no snapshot
has its completion gate skipped entirely (`lib/tick.mjs:294`: `log.warn`, then `if (prd)` is false, and the ready
branch runs on checks and the reviewer alone). Driven: an entry with `readPrd` returning null and a PR body carrying no
receipt at all reaches `ready-for-human` and notifies, with `no PRD snapshot, completion gate skipped` in the log and
nothing anywhere else. The warning does fire on the right tick, so this is visible to someone reading `errors.log`; it
is invisible in `status`, in `why`, in the ntfy message and on the PR, all of which say the same thing they say for a
PR that passed the gate. Same end state as F2 by a different route, and cheap to close: carry it in the entry so
`status` and `why` can say the gate did not run.

---

## The cursor, writer by writer

The brief asked for this explicitly, so it is set out in full: what each field means, who writes it, and whether any
writer can violate the invariant.

| Field | Meaning | Writers | Can a writer violate it? |
|---|---|---|---|
| `since` | Events at or after this instant are new. | `newEntry` (`state.mjs:131`), `settleRun` PR-open branch (`tick.mjs:148`), `settleRun` push branch (`tick.mjs:169`), `dispatch` (`tick.mjs:212`), `register` (`register.mjs:74`), `reconcile` (`up.mjs:51`) | **Yes, two of them.** `settleRun`'s push branch writes the head's committer date unguarded (F1); `dispatch` on the receipt path writes `readAt` unguarded (F1). The other four write a GitHub timestamp or a floored local instant at entry creation, where there is no prior cursor to regress from. |
| `dispatched` | Event keys already handled at exactly `since`. | Only `advanceCursor` (`state.mjs:112`) and the literal `[]` at entry creation. | No, as a mechanism: it is cleared exactly when `since` moves to a different instant and unioned when it stays. It is emptied wrongly only as a consequence of F1's backwards move. |
| `fixed_sha` | The head when the last run started; a run that pushed is recognised by the head moving. | `settleRun` (both branches), `dispatch`, `register`, `reconcile`, and the head-move reopen (`tick.mjs:285`). | No. Every writer sets it to `pr.headRefOid` as just read from GitHub. Both readers (`settleRun`'s `pushed` test, the reopen test) only need it to name a head that was observed, which it always does. |
| `checks_sha` | The head whose failing checks were already dispatched. | `dispatch`, when the batch contained a check event (`tick.mjs:212`); `reconcile`, to the recovered head (`up.mjs:51`); `null` at entry creation and on `register`. | No. It is only ever set to a head GitHub reported, and only after that head's failures were actually sent or deliberately suppressed. |
| `receipt_hash` | The receipt fingerprint when the last run started. | `settleRun` (both branches), `dispatch`, `register`. **`reconcile` writes `null` regardless of the body it already holds.** | **Yes, one of them.** F5: the `null` from `reconcile` makes any pre-existing receipt read as a change, so a run that did nothing counts as a round. |

`rereview.at` is not a cursor field but is read the same way (the reviewer verdict's boundary, the nudge timer and
the `reviewer-silent` stop all measure from it) and is worth a row of its own. Five writers:
`settleRun`'s PR-open branch (`pr.createdAt`), `settleRun`'s push branch (`tick.mjs:170`, the same unguarded `since`
as F1), the head-move reopen (`tick.mjs:285`, added during this audit), `register` and `reconcile`.

Two of those five take the head's committer date from `headPushedAt` with no floor against the current time, so both
carry F1's shape. The reopen path is the newer one and is written up as F9 below.

---

## Invariants verified as holding

**The PRD the gate reads is the daemon's own snapshot.** Confirmed. The only reader is `readPrd`, which resolves to
`~/.gallivant/prds/<slug>.md` (`lib/context.mjs:14,30`). `prdFor` (`lib/tick.mjs:61`) is the single entry point for
the tick, and `verifyFor`, `receiptFor`, `criteriaFromPrd` and `resolveContextPaths` all go through it. No path in
`lib/tick.mjs` reads anything under `entry.worktree`; the worktree copy written by `start`
(`lib/commands/start.mjs:53`) is never read back. The defect in F2 is in what may be written into the snapshot, not
in where it is read from.

**`assertSafeArgv` cannot be bypassed by a brief, a config, or a PR body.** Confirmed by exercising every input into
argv. `buildRun` is the only builder and both spawn paths go through it (`lib/tick.mjs:121`,
`lib/commands/start.mjs:60`). The variable inputs are the prompt, the session, the budget, the settings path and the
context paths, and four of the five are closed:

- The prompt is the last argv element and is never split, so `-c sandbox_mode="danger-full-access"` typed into a PRD
  arrives as one element, is never read as a flag, and is refused by `DANGEROUS_VALUES` in any case.
- `contextPaths`: `validateContextPaths` rejects anything not starting with `/` or `~`, so `--dangerously-skip-permissions`
  and `-y` are dropped before `withContext` ever renders them, and `assertSafeArgv` runs after `withContext`
  (`lib/harness.mjs:325`) so it would catch them even if the list let them through.
- A session that came from a PR body is validated per harness by `parseBlock` (`lib/block.mjs:19`, calling each
  adapter's `isSession`). Driven against `--dangerously-skip-permissions`, `-y`, `../../etc/passwd`, `ses_--auto`,
  `gallivant-..` and `gallivant-x/y`: every one is refused by name.
- `budget` is `String(config.max_budget_usd)` and `validate` requires a number.

The fifth is F8: `register --session` skips that validator entirely and lands in argv position 2. So the invariant
holds for everything the daemon reads and fails for one thing the operator types.

Two adjacent gaps that are not bugs on their own, since nothing reaches them without an adapter edit, but which make
F8 worse than it needs to be. `assertSafeArgv` matches literal spellings, so `--approval-mode=yolo` (equals form),
`--sandbox danger-full-access`, `-s danger-full-access`, `--permission-mode bypassPermissions` and
`--permission-prompts allow` all pass. `assertSafeEnv` is narrower still: it checks `GOOSE_MODE` and nothing else, so
it would not refuse `CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS` if an adapter's `env()` ever returned it. `GOOSE_MODE`
is also case-sensitive, so `SMART_APPROVE` is refused where `smart_approve` is allowed, which is the safe direction
but is an accident rather than a decision.

**One notification per transition, for `needs`.** Confirmed for every stop reached in testing. `conflict`,
`no-push`, `harness-error`, `timeout`, `iterations`, `reviewer-silent`, `reviewer-blocking` and `checks-red` each
fire once: the first three because the state moves to `needs-human` and `tickEntry` returns at `lib/tick.mjs:242` on
every later tick; `reviewer-blocking` and `checks-red` because they carry a second guard on `last.event` naming
the head. `reviewer-silent` was driven for two consecutive ticks and notified once.

**`notify.ready` fires once per transition.** Confirmed. The guard is the state itself: the ready branch is inside
`if (entry.state !== STATES.prOpen) return;`, and the new head-move reopen (`lib/tick.mjs:276`) is the only path back
in, so a second `ready` notification requires a real second transition. With the fix landed during this audit, a
failed label write leaves the entry in `pr-open` and notifies nobody, which is the right answer.

**`cursor.dispatched` and the inclusive boundary.** The pairing is correct where it is written: `advanceCursor`
(`lib/state.mjs:112`) clears the list on a move to a different instant and unions on a move within the same second,
and `deriveEvents` (`lib/events.mjs:46`) is inclusive of `since` and keyed by `kind:id` across the three id spaces.
The server-side `since` filters are asked for from a second early (`fetchFrom`, `lib/tick.mjs:30`) so the overlap the
dedup needs is actually fetched. The defect in F1 is that one writer moves `since` to an earlier instant, which
clears a list that was still needed; the mechanism itself is sound.

**`cursor.checks_sha` and `cursor.fixed_sha`.** Both hold. See the writer-by-writer table above for the reasoning; in
short, every writer of either sets it to a `pr.headRefOid` just read from GitHub, and neither reader needs anything
stronger than "this names a head that was observed".

**The event derivation never loses an event to a handled review.** Worth stating because the control flow invites it:
the reviews loop calls `inlineByReview.delete(r.id)` only when the review qualified and was pushed, so a review that
is behind the cursor, or that does not qualify, leaves its inline comments in the map for the standalone loop to
examine on their own timestamps. Driven three ways (a later inline on an already-handled review, an inline on a
non-qualifying review, and two inlines on one review with different timestamps): each time the new item was derived
and the handled ones were not.

**Failing checks cannot be dispatched twice for one head.** A check event has no `id`, so its key can never enter
`cursor.dispatched`; suppression is entirely `checks_sha`, and `dispatch` sets it whenever the batch contained a check.
Driven: the same `FAILURE` rollup derives one event before `checks_sha` is set and zero after. Duplicate check names
within one rollup are collapsed by the `seen` set (`lib/events.mjs:88-90`).

**`serve` is read-only.** Confirmed as a property of the route table: every key in `routes` is `GET`, no handler
writes a file, and the two paths that could build a filesystem path from a query string do not
(`entryFrom` matches the id against the registry, `runFor` validates the run id and reads it back through the
runner). It binds `127.0.0.1` with no fallback.

---

## Fixed while this was written

Recorded so a reader does not take them for new defects. Both were live when the audit opened and were fixed by
another agent under it; both were reproduced in the broken state and re-run in the fixed one.

- **A ready entry whose head moved kept the ready label.** With the entry in `ready-for-human` and a new green head,
  the tick returned at `if (entry.state !== STATES.prOpen) return;` without comparing the head, so the label saying a
  human could merge it stayed on a commit nobody had reviewed, with nothing logged. Now `lib/tick.mjs:276` compares
  `pr.headRefOid` against `cursor.fixed_sha`, calls `reopen`, and judges the new head in the same pass.
- **The ready label write was best-effort after the state moved.** `save(state: ready)` came first and `addLabel`'s
  failure was logged and dropped, so a rate-limited GitHub left a ready entry with no label and no retry. Now the
  label goes on first and a failure returns without moving the state (`lib/tick.mjs:330`).
