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

---

# Round six: the holistic check after fixing five Codex findings

Appended 2026-09-26 against `feat/v0.1`, on top of `bbf3b4c`. Five findings were fixed in `lib/tick.mjs` (three),
`lib/commands/start.mjs` and `lib/commands/register.mjs`; the suite went from 269 to 275 tests, and each of the six
new tests was run against the pre-change file and observed to fail. What follows is the three questions the brief
asked after the fixes, answered against the tree as it now stands.

## 1. Ordering: every transition, and whether a failure at any point is recoverable

The rule the three ordering findings share: **a durable write that another actor will read must land before, or in the
same step as, the thing it describes.** Three sub-rules fall out of it, and each of the three findings was one of them
being broken on one path while its sibling honoured it.

- A **process** must be recorded before anything else can fail (finding 1).
- A **state the next tick retries from** must be what a tick failure leaves, because a tick has no operator
  (finding 3).
- A **marker another reader counts from** must exist before the local count that assumes it (finding 5).

Every transition in the tick, in the order the steps run:

| # | Transition | Durable writes, in order | Safe? |
|---|---|---|---|
| 1 | `running` → `pr-open` (start run ended, PR found) | `gh.setBody` (the identity block), then `save(state, pr, session, cursor, rereview)` | **Yes, now.** The block was best-effort and is now a precondition: a failure saves the session only and returns, leaving `running` with `last.exit` unrecorded, which is what `settleRun` re-enters on. Driven: the next tick writes the block and completes the transition in that same pass, with no second spawn. |
| 2 | `running` → `needs-human` (`no-pr`) | `save(needs-human)`, then the two labels, then `notify` | Yes. Entry has no PR, so there is nothing to label; the state is the signal and `needsHuman` retries the labels through `labels_pending` when there is a PR. |
| 3 | `running`/`pr-open` → `needs-human` (`timeout`) | `runner.kill`, then `save`, then labels, then `notify` | Yes. The kill is not durable state; a crash after it and before the save leaves a dead process and an entry whose `last.run` has no exit, which the next tick settles through the ordinary path. |
| 4 | `pr-open` → `pr-open`, round counted (a run that pushed or rewrote the receipt) | `gh.comment` (the round comment), then `save(cursor, iteration, rereview)` | Yes, and deliberately this way round: the comment goes first so a crash leaves a comment rather than losing one, and `commentOnce` makes the retry harmless by recognising the marker. The reverse order would count a round on the PR nobody was told about. |
| 5 | `pr-open` → `needs-human` (`no-push`, `harness-error`) | `save`, then labels, then `notify` | Yes. Same shape as 2, and `labels_pending` covers the label half. |
| 6 | `ready`/`pr-open` → `pr-open` (untracked head change) | `gh.removeLabel` when it was ready, then `save(fixed_sha, rereview)` | Yes. The label comes off first for the same reason it goes on last in the ready transition: the PR must not say a human may merge a commit the loop is about to judge. A throw leaves the whole judgement for the next tick, which re-reads the same head. |
| 7 | `pr-open`/`ready` → `pr-open`, run dispatched | `gh.removeLabel` when it was ready, then `runner.start`, then `save(state, cursor, last.run)` | **Yes, now.** This was finding 1: the spawn was first and the label removal could throw between it and the save. Everything that can throw is now above the spawn, and the save is immediately below it with no `await` between. |
| 8 | `pr-open` → `needs-human` (`iterations`, `context-paths`, `no-worktree`) | `save`, then labels, then `notify` | Yes. All three are refusals decided before anything was spawned, so there is no run to orphan. |
| 9 | `pr-open` → `ready` | `gh.addLabel`, then `save(state)`, then `notify` | Yes, fixed last round. The label goes on first because a later tick returns early on `ready`, so a swallowed label write would have no retry; a failure returns and leaves `pr-open`, which is the retryable state. |
| 10 | `pr-open` → `needs-human` (`conflict`, `draft`, `reviewer-blocking`, `checks-red`, `reviewer-silent`) | `save`, then labels, then `notify` | Yes. The state is the stop; `labels_pending` retries the labels; the four that carry a `last.event` guard notify once per head. |
| 11 | `pr-open` → `pr-open`, nudged | `gh.comment`, then `save(rereview.nudged)` | Yes. Same as 4: comment first, idempotent on the marker. |
| 12 | anything → `done` | `save(state)` | Yes. One write, and GitHub already holds the truth. |
| 13 | `needs-human` → `needs-human`, labels finished | labels, then `save(labels_pending: false)` | Yes. Write first, flag second; a crash between them repeats a label write that is idempotent. |

Outside the tick, the two commands:

| Transition | Writes, in order | Safe? |
|---|---|---|
| `start`: nothing → `running` | spec built, snapshot written, clone, brief written into the clone, spawn, `state.put` | **Yes, now.** This was finding 4: `buildRun` could refuse after the clone. Every refusal is now above the clone, and the spawn is immediately before the `state.put` that owns it. The snapshot write moved below the spec build too, so a refused run leaves no snapshot either. |
| `register`: nothing/existing → `pr-open` | block write, reset comment, `state.put`, snapshot | **Yes, now.** This was finding 5: the reset comment was best-effort before the local reset. Both GitHub writes are now preconditions and both precede `state.put`, so a failure in either leaves the registry untouched and the same command reruns cleanly. The snapshot stays deliberately last and deliberately non-fatal, with the reasoning written at its call site: an entry watched with no snapshot is worse than an aborted registration only if the gate then passes silently, and that is carried on the entry as `gate_skipped` for `status` and `why` to say. |

The asymmetry between finding 3 and finding 5 is the point worth keeping. Both are "the write that another reader
counts on was best-effort", and the two get opposite fixes because the actor differs. `register` has an operator in
front of it, so refusing is the whole recovery. The tick has none and must never abandon an entry, so it needs a state
the next tick re-enters. `running` with `last.exit` unrecorded is that state, and it retries rather than spins because
the work it repeats is two GitHub reads and one write: when the write lands, the entry completes the transition in
that same pass.

## 2. Sibling paths: the recurring shape, hunted deliberately

Three sweeps, as the brief asked.

**Every `.catch(` in `lib/tick.mjs`.** There is now exactly one, and it is the intended kind:

- `tick.mjs:180`, `headPushedAt`: `gh.commitDate(...).then(d => d || fallback).catch(() => fallback)`. A deliberate
  fallback, not a swallowed write: the caller always has a usable answer, and the value is then floored by
  `reviewerClock` anyway. Sound.

The two that were swallowed writes are gone: `tick.mjs:196` (the block write, finding 3) and the two label writes
fixed in earlier rounds. So the class the audits kept naming in this file is, as of this round, empty.

**Every `.catch(` in `lib/commands/`.** Seven, of which five are fine and two are worth stating:

- `register.mjs:109` and `start.mjs:79`, `ensureLabels`: a repo-level convenience whose absence costs nothing the
  entry depends on. Sound, and both spellings agree.
- `doctor.mjs:76,97,104,195`: four reads whose whole job is to report a gap. A throw would be the wrong answer for a
  command that exists to print what is wrong. Sound.
- `up.mjs:45`, `gh.commitDate(...).catch(() => null)` inside `reconcile`: the same deliberate fallback as
  `headPushedAt`, with `pr.createdAt` behind it. Sound.
- `register.mjs`'s `ensurePrdSnapshot` has no catch of its own any more; `prd.mjs` owns the decision, which is the
  consolidation the structure audit's finding 11 asked for. Worth noting that the two callers therefore now agree,
  which they did not when that audit was written.

**Every write of `rereview`.** Seven, and one sibling asymmetry is live:

| Site | Value written | Floored at the nudge window? |
|---|---|---|
| `state.mjs:146` (`newEntry`) | `null` | n/a, there is no head yet |
| `tick.mjs:160` (`headChanged`) | `reviewerClock(entry, pushedAt)` | **Yes** |
| `tick.mjs:263` (start run → `pr-open`) | `pr.createdAt` | n/a: a PR cannot be older than its own creation by more than the window in any way that matters, and the events cursor is the same value |
| `tick.mjs:289` (a round that pushed) | `reviewerClock(entry, pushedAt)` | **Yes** |
| `tick.mjs:514` (the nudge) | carries `at` unchanged, sets `nudged` | n/a |
| `register.mjs:98` | `floorSecond(nowIso())` on a reset, `pr.createdAt` on a fresh one | Safe by construction: a reset's clock is now |
| **`up.mjs:57` (`reconcile`)** | `later(lastOwn, pr.createdAt)`, **unfloored** | **No** |

The `reconcile` write is the one sibling of `reviewerClock` that does not go through it, and it is reachable. Driven
against the tree: a PR whose block is valid, whose last Gallivant round comment is seven hours old, recovered with
`stall_hours: 6`, is stopped on the **first tick after recovery**:

```
recovered rereview.at: 2026-09-24T02:00:00.000Z   (the round comment's own time, 7h before now)
first tick after recovery -> state: needs-human  reason: reviewer-silent  notify: [["needs",142,"reviewer-silent"]]
```

Not fixed, and reported rather than fixed for a reason: unlike F7, the silence here is arguably true. The daemon did
ask, seven hours ago, and the reviewer did not answer; a recovery that forgave that would hide a real stall. But the
asymmetry is real and the operator-visible behaviour is "the daemon booted and immediately stopped a PR", which reads
as a recovery bug whether or not it is one. Whoever owns the reviewer story should decide whether a recovered entry
gets a grace window, and if it does, `reviewerClock` is where it belongs so there is one answer rather than two.

**Every place a head sha is compared.** Five, and they now reduce to three questions with one comparison each:

- `tick.mjs:153` (`headChanged`), "is the head the one the loop last acted on?" **This is the consolidation.** It
  was two sites' worth of behaviour implemented for one state; both watching states now reach the one function.
- `tick.mjs:271` (`settleRun`), "did the run that just ended push?" Same field, different question, and it must stay
  separate: it is asked about a run, not about an entry being judged.
- `events.mjs:98`, failing checks against `cursor.checks_sha`; `tick.mjs:506`, the `checks-red` stop against the same.
  One field, one question, asked in the pure function and in the stop that follows it. Consistent.
- `events.mjs:161-162`, the reviewed commit against the head. The `!reviewed` case is `waiting`, which is F3's fix, so
  the absent-value sibling is closed here.

Two more sibling observations from the same sweep, neither fixed:

- `up.mjs:56` sets `checks_sha: pr.headRefOid` on a recovered entry, so a head that is genuinely red at recovery has
  its failures suppressed rather than dispatched. `register.mjs:97` sets `checks_sha: null` for the same situation, so
  a registered PR's red head IS dispatched. Two commands, the same question, opposite answers. `reconcile`'s choice
  is defensible (the daemon may already have dispatched them before it lost the registry) and `register`'s is too (an
  operator registering a PR wants its current state addressed), but nothing in either file says the other exists.
- `writeStopLabels` tracks its retry on `addLabel` and logs `removeLabel`'s failure separately. That is deliberate and
  documented at the site. Noted so a later reader does not "fix" the asymmetry into a retry loop on a label that
  `removeLabel` already treats as absent.

## 3. What these fixes make newly possible

Three rounds running, a fix produced the next round's finding, so each change is read back for the same question.

**Finding 1, `reopen` moved above the spawn.** What is newly possible: a transient `removeLabel` failure now blocks
the dispatch rather than merely mislabelling it. An entry can therefore sit in `ready` with feedback waiting, doing
nothing, for as long as GitHub refuses that one call. That is strictly better than a double fixer, and it is bounded
in a way the old behaviour was not (the cursor does not move, so the work is not lost), but it is a new way for an
entry to be stuck with no stop and no notification: the only trace is the `log.warn` on each tick. If a future round
wants a stop for it, the shape already exists (`needsHuman` with a reason after N consecutive failures), and the
counter would have to live on the entry. **I am naming this as the most likely next finding from this diff.**

**Finding 2, one `headChanged` for both states.** What is newly possible: a `pr-open` entry's `rereview.nudged` now
resets on any head change, so a PR receiving frequent pushes can be nudged once per push rather than once per round.
With `rereview_minutes: 6` and a human pushing every ten minutes, that is a nudge comment per push. `commentOnce`
bounds it (a nudge already posted after `rereview.at` is not reposted), and the nudge only fires past the window, so
the real bound is one comment per `rereview_minutes` rather than one per push. I believe that is acceptable and it is
the same rate the round path already allows, but it is a genuine behaviour change on a path that previously never
nudged twice, and it is worth a look by whoever owns the reviewer story. Second-order: `headChanged` now runs on every
`pr-open` tick, which means one extra `gh.commitDate` per head change where there used to be none for this state.
That is one API call on a transition, not per tick, since the next tick's `fixed_sha` already matches.

**Finding 3, the block write made retryable in `running`.** What is newly possible: an entry can now stay in `running`
indefinitely while GitHub refuses `setBody`, with its PR open and unwatched. The old behaviour reached `pr-open` and
watched the PR with no block; the new one does not watch it at all until the block lands. Which is worse depends on
what fails: for a permissions problem that will not resolve (a token without write access to the body), the new
behaviour is a silent stall where the old one was a silently unrecoverable entry. Both are bad and neither is stopped.
The honest answer is that this trades one unbounded wait for another and picks the one whose invariant survives; a
stop after N failures would close both, and it is the same missing counter as finding 1's. Also newly true: `status`
shows the entry as `running` when the process has in fact ended, because `last.exit` is deliberately unrecorded. The
`status` line for `running` reads "start run in progress", which is now sometimes untrue. Nobody is misled about
anything actionable, but I cannot claim the wording is right.

**Finding 4, the spec built before the clone.** What is newly possible: the run spec's `cwd` is now
`worktreePath(...)` rather than `git.create`'s return value. No adapter reads `ctx.cwd` today, so the two can only
disagree harmlessly, and `start` logs a warning when they do. If `cwd` ever reaches argv, that warning has to become a
refusal, and the comment at the site says so. The other change: the PRD snapshot is now written after the spec is
built, so a refused run no longer leaves a snapshot behind. That is a cleanup rather than a risk. I can see no third
consequence of this one.

**Finding 5, the reset comment made a precondition.** What is newly possible: `register` can now fail on an entry that
exists where it previously succeeded, and the failure mode is "GitHub will not let me comment". A repository where the
token can read and write bodies but not post comments would have had a working reset and now has none. That is the
intended trade (the reset was never really working there: the boundary was not being recorded), but it is a new
refusal on a command operators reach for when something is already wrong, which is the worst moment for a new
refusal. The message names the cause, the PR and what was not changed, which is the mitigation. Second-order: the
comment is now posted before `state.put`, so a crash between them leaves a reset comment on the PR with no local
reset, and the next `register` posts a second one. `countRounds` takes the **last** reset marker, so two markers count
the same as one. Verified by reading `events.mjs:183`.

One thing I cannot answer, stated rather than guessed: whether `headChanged` running before the verdict rather than
after changes any interaction with `reviewerVerdict`'s `dispatched` argument. `entry.cursor.dispatched` is passed to
the verdict and `headChanged` does not touch it, so I believe it does not, but the two were never ordered this way for
`pr-open` before and I have not driven the case where a reviewer's review sits at exactly the cursor second on a head
that just moved.

---

# Round seven: the three items round six reported rather than fixed

Appended 2026-09-26 against `feat/v0.1`, on top of `b81ffd7`. Round six named three defects and declined to fix them,
and named one question it could not answer. All four are closed here. The suite went from 275 to 289 tests; each new
or changed test was run against the pre-change files and observed to fail, except the one that answers the open
question, which passes against both because it demonstrates rather than fixes (said so at the site).

## 1. The unbounded silent wait, closed with one counter for three callers

Round six's own prediction: "the shape already exists (`needsHuman` with a reason after N consecutive failures), and
the counter would have to live on the entry. I am naming this as the most likely next finding from this diff." It was.

**What was wrong.** Three steps in the tick decline rather than proceed when one GitHub write will not land, because
proceeding leaves a worse state than waiting. Two were named in round six and a third was not:

| Step | The write | What a permanent failure left |
|---|---|---|
| `dispatch`, before the spawn | `reopen`'s `removeLabel` | `ready` forever, feedback waiting, nothing spawned, one `log.warn` per tick |
| `settleRun`, `running` → `pr-open` | `gh.setBody`, the identity block | `running` forever, an open PR unwatched, one `log.warn` per tick |
| `headChanged`, a moved head on a ready entry | the same `removeLabel` | a throw out to the per-entry catch, so one `log.error` per tick and the new head never judged |

The third is the sibling round six's own sweep would have found next: it is the same declining write, reached from a
different caller, and it was worse than the other two because it did not even decline deliberately. It threw.

**The fix.** `entry.retry` is `{ op, count }`, and two functions in `tick.mjs` own it:

- `retryFailed(id, entry, op, err, { action, onStop })` increments the count when `op` matches the one already
  recorded and starts from one when it does not, logs the attempt with its number, and at `MAX_WRITE_FAILURES` stops
  the entry through `needsHuman(id, "stuck", ...)` with `last.event` naming the write, the streak and GitHub's own
  message.
- `retryOk(id, entry)` clears the field, and writes nothing when there is nothing to clear.

Consecutive, not cumulative, and that is the whole point: `retryOk` runs on the success path of each of the three
callers, and the `running` → `pr-open` transition folds `retry: null` into the save that IS that write succeeding.
A different `op` failing resets rather than accumulating, because the count answers "is this one write permanently
broken" and two broken writes are two answers.

`onStop` exists for one case. The start-run path has read the PR number by the time the block write refuses it, and a
stopped entry that names its PR is one the operator can click through to, while a *retrying* one must not claim to
watch a PR whose identity block is still missing (round six's own invariant, and a test asserts it on every retrying
tick). So `pr` and `url` are recorded on the stop and never on a retry.

**The threshold: five, as a constant with a comment, not a config key.** The brief asked for the reasoning, so:

- `max_iterations` is the wrong knob and the brief already said why. It counts fix rounds. A round costs a harness run
  and money; these cost one API call. Tying them would either stop a transient rate limit after three ticks or let a
  revoked token run for as long as the operator was willing to pay for rounds.
- A new key would be one more thing in `config.json` with no right answer to tune it to. The only question the number
  answers is "transient or permanent", and it does not vary by install. At the default `poll_seconds: 120`, five ticks
  is ten minutes: longer than a GitHub rate-limit window or an abuse pause, and far short of a token that cannot write
  PR bodies, which no amount of waiting fixes.
- An operator who lowered it would get earlier stops for transient failures, which is the failure mode that already
  annoys them; one who raised it would get exactly the silence this finding is about. Neither direction is an
  improvement, which is the test for whether something should be a key.

`docs/config.md` now has a "What is deliberately not a key" section so the next reader does not go looking for it.

**The reason string.** `stuck`, consistent with `no-push`, `checks-red`, `reviewer-silent` and `context-paths`: a
hyphenated state of the entry, not a sentence. What tells the operator what to do is `last.event`, which carries the
write, the streak and GitHub's message verbatim, and `docs/commands.md` now translates the two messages this actually
produces in practice (`Resource not accessible by personal access token` on a body write means the token cannot edit
PR descriptions; on a label write, that it cannot edit issues) and says the way back is `register`.

**Tests**, all five failing against the pre-change `lib/`:

- repeated failure of the ready-label removal stops with `stuck` on the fifth tick, exactly one notification, the
  needs-human label on the PR, the write and GitHub's message in `last.event`, and nothing notified on the tick after;
- four failures then a success: the count is cleared, the entry proceeds, the waiting feedback is dispatched, nobody
  was ever told, and the next failure of the same write is attempt one again;
- a single failure stops nothing and notifies nobody;
- the block write, driven to the stop, sharing the same counter by name and keeping `pr` null on every retrying tick;
- the third caller, `headChanged`, handled inside the tick rather than thrown at the per-entry catch.

## 2. `up.mjs`: the recovered reviewer clock, fixed

Round six reported this rather than fixing it because "the silence is arguably true". The brief disagreed and gave the
reasoning to apply; applying it, the brief is right, and the reason round six's version is not quite wrong is worth
recording: the silence IS true as a fact about the reviewer. It is not true as a fact about the daemon, and the timer
is the daemon's. `stall_hours` measures how long the daemon has been asking without an answer, and during the window
in question the daemon was not asking, it was not running. Charging the entry for it stops a PR on the first tick
after a crash for a wait nobody was serving, tells the operator nothing they can act on, and costs them a `register`.

So `rereview.at` on a recovered entry now goes through the same floor the tick's writers use. That meant moving the
rule: `reviewerClock` was a closure inside `makeTick` over `config` and `clock`, and `reconcile` lives in `up.mjs` and
has neither. It is now a pure exported function in `events.mjs`,
`reviewerClock({ config, pushedAt, previousAsk, floorAt })`, which is where the separation of concern puts it (a rule
over data, no side effects) and which makes it unit-testable on its own for the first time. `tick.mjs` keeps a
one-line `askedAt(entry, pushedAt)` adapter so its two call sites read as they did.

There are now four writers of `rereview.at` that have a head in hand, and all four reach the one function. The three
that do not are `newEntry` (null, no head yet), the nudge (carries `at` unchanged) and `register`'s reset (`now`,
which is the ask, and safe by construction).

**Tests**: a unit test on `reviewerClock` itself covering all four of its clauses, and a recovery test asserting that
a PR whose last round comment is two days old comes back with an ask no older than `rereview_minutes` and nothing
already past `stall_hours`. The recovery test fails against the pre-change `up.mjs`.

## 3. `checks_sha` on recovery versus on register: `register` was right, and both now say so

Round six recorded both answers as defensible. They are not equally defensible, and the argument that decides it is
one neither file made.

`reconcile`'s case was "the daemon may already have dispatched them before it lost the registry". Trace what "already
dispatched" can mean on the head that is actually there at recovery:

- Dispatched and the fix pushed: the head MOVED, so the red checks on the current head are a different head's checks.
  Nothing to suppress.
- Dispatched and the fix did not push: the run is orphaned by the crash, its work is lost, and redoing it is the point.
- Never dispatched: obviously dispatch.

So no head qualifies as "already sent" on a recovery, and `register`'s `null` is the correct answer for both commands.

The second half of the argument is what makes the old behaviour actively wrong rather than merely conservative.
Suppressing the failures is not the same as stopping for them. `checks-red` fires only when the reviewer verdict is
not `waiting` (`tick.mjs:569`), and on a recovery with a bot reviewer that has not spoken since the recovered cursor
it IS waiting. So a genuinely red head arrived suppressed, fell past the `checks-red` branch, went to the silence step
and stopped the entry with `reviewer-silent` after `stall_hours`, naming a reviewer problem for a CI problem. The
operator was told the wrong thing about the wrong actor.

`reconcile` now writes `checks_sha: null`, with the reasoning at the site, and `register.mjs:97` carries the matching
comment naming `reconcile` so neither file can drift again. **Test**: a recovery test asserting the null and then
reading it through the rule that consumes it, `deriveEvents`, so the assertion is about the behaviour and not just the
field. Fails against the pre-change `up.mjs`.

## Also: the `status` wording

Round six: "`status` shows the entry as `running` when the process has in fact ended... I cannot claim the wording is
right." It was not. `inFlight` is `last.run && last.exit == null`, which the block-write retry deliberately leaves
true, so the row read `implementing  ended, settling on the next tick` on every poll. The process had ended; the tick
was not settling it, it was retrying one write and counting the failures.

`model()` now has a branch above `inFlight`: when `entry.retry` is set, the detail is
`<op> failing (<count>), retrying`. It outranks the run's liveness because it is what the entry is actually waiting
on. `retry` is also on the row, so `--json` and the tracker get the same facts, and `why` prints a fuller line saying
the wait is bounded and what it stops with. Two tests: the retrying row, and an in-flight row with no retry reading
exactly as it did.

## The open question: `headChanged` before `reviewerVerdict`, and the `dispatched` argument

Round six stated this rather than guessing. The answer is that there is no interaction, and the order that exists is
the safer of the two orders. Two independent reasons, and the test drives both:

1. **`headChanged` does not touch either half of the pair the verdict depends on.** It writes `state`,
   `gate_skipped`, `cursor.fixed_sha` and `rereview`. `cursor.since` and `cursor.dispatched` are carried through by
   the `{ ...entry.cursor, fixed_sha }` spread untouched, so the list the verdict is handed is byte-identical to the
   one it would have been handed under the old order. Only the events step and `advanceCursor` move that pair.
2. **`rereview.at` only ever moves forward, so running it first can only narrow the verdict's window.**
   `reviewerClock` is `later(later(pushedAt, floor), previousAsk)`, and `previousAsk` is the current value, so the
   result is never earlier than what was there. A narrower window excludes more reviews, which turns `clear` into
   `waiting` and never the reverse. `waiting` is the answer that waits; `clear` is the answer that marks a PR ready.
   An order that can only fail toward waiting is the safe one.

Driven at exactly the second in question, on a head that just moved:

- a review at the cursor second, in `cursor.dispatched`, naming the NEW head: `dispatched` excludes it from the
  verdict, the head change leaves the list alone, and the entry stays `pr-open` rather than going ready on the
  strength of feedback it is still fixing;
- the same second, a review NOT in `dispatched`, clearing the new head: under the old order the verdict ran against
  the OLD reviewer clock, which is earlier, so the review was inside the window and the entry went ready on a head
  `fixed_sha` had not caught up to. The reset moves the ask to the push, which is after the review, so it now waits;
- the reviewer then answers the head it was actually asked about, and the entry goes ready on the next tick, so the
  narrowing is a boundary and not a door that stays shut.

That test passes against the pre-change tree as well, and says so at the top: it demonstrates a property of the
existing order rather than fixing a defect. It is here so the question cannot be open a third time.

## What these changes make newly possible

Four rounds running, a fix produced the next round's finding, so the same read-back.

**The counter.** An entry can now stop for a reason that is not about the PR at all. `stuck` says "GitHub would not
let me do one thing five times in a row", and the operator's action is to fix a token or wait out an outage, not to
look at the diff. That is a new *kind* of stop on a tool whose other twelve reasons are all about the work, and the
mitigation is entirely in the message: `last.event` carries the write and GitHub's words, `why` prints it, and
`docs/commands.md` translates the two spellings that actually occur. The residual risk I can name: a GitHub outage
longer than ten minutes now stops every watched entry that happens to need one of these three writes during it, each
with its own notification, where before they all waited silently. That is the trade the finding asked for and I think
it is right (a stopped entry with a reason is recoverable by one `register`; a silent one is not recoverable at all,
because nobody knows it needs recovering), but a very long outage is now noisier than it was. If a future round wants
that quieter, the answer is a notification class rather than a longer threshold.

**`retry` on the entry.** One more field that `register` has to clear, and it does, with a test. This is the fourth
field in that list (`reason`, `iteration`, `retry`, and the cursor), and the next one added will be the next thing
someone forgets. Flagged here for whoever adds a fifth.

**`reviewerClock` moved to `events.mjs`.** Newly possible: a caller can pass a `floorAt` that is not now. Every caller
today passes the current time, and the parameter exists only because `reconcile` has no injected clock while the tick
does. A caller that passed an older `floorAt` would reintroduce exactly the bug this fixed, so the name is `floorAt`
and not `now` and the doc comment says what it is for. Second-order: `events.mjs` now imports `later` and
`floorSecond` from `time.mjs`, which it did not before. Still pure.

**`checks_sha: null` on recovery.** Newly possible: a boot that adopts a red PR now dispatches a fix round for it
immediately, which costs a harness run the old behaviour did not spend. That is the intended trade, and it is bounded
by the recovered `iteration`: an entry recovered at `max_iterations` stops with `iterations` rather than dispatching.
An operator who boots the daemon against five red PRs will get five fix rounds, where before they got five PRs that
did nothing until the reviewer clock expired. I believe that is what they wanted from a daemon, but it is a real
change in what a boot costs.

**The `status` branch.** Newly possible: a row can say `fixing  ready label removal failing (3), retrying` while a fix
run is genuinely still alive, because `retry` now outranks `inFlight`. Not reachable today: the ready-label removal
happens before the spawn and the entry cannot be retrying it while a run of its own is in flight, since `retry` is
cleared on the tick that dispatches. If a fourth caller of `retryFailed` is ever added on a path that runs alongside a
live run, that row would hide the run, and this is where to look.

---

# Round eight: the sibling that omission chose, and the tests that only passed here

Appended 2026-09-26 against `feat/v0.1`, on top of `8ec1716`. Five findings, all five real, all five fixed. Four are
direct consequences of round seven's own diff, which is the pattern this document exists to name; the fifth is a test
defect that had been latent since the symlink refusals were written. The suite went from 289 to 298 tests. Every new or
changed test was run against the pre-change files and observed to fail, with two exceptions that say so at the site
because they guard a success path rather than fix a defect.

Two extra defects were found by the sweeps at the end and fixed with the findings, because both are the same shape and
leaving a known unbounded wait in the tree after being asked to enumerate them would be worse than reporting it.

## 1. `strict` was opt-in, so omission chose the dangerous half

**What was wrong.** `gh.removeLabel` took `{ strict = false }`. With `strict`, everything but gh's own "label not
found" throws; without it, every rejection was swallowed. Two callers of that one write, and they disagreed:
`writeStopLabels` passed `{ strict: true }`, `reopen` passed nothing. So a 403 or a 502 on the ready-label removal
resolved as though the label had merely been absent. `reopen`'s two callers then went ahead: `dispatch` spawned a fixer
and `headChanged` judged a new head, both with `gallivant:ready-for-human` still on the PR, and `retryFailed` never saw
a failure to count. Round seven's whole first finding was about bounding that wait, and the bound was unreachable from
one of the two paths that needed it.

**The fix, and why this one rather than passing the flag.** The option is now `lenient`, defaulting to false, and the
throw is what a caller gets by writing nothing. Passing `{ strict: true }` at the second call site would have closed
this instance and left the shape: a third caller would still have got the dangerous behaviour by omission, and the
reason this slipped is precisely that omission was the dangerous spelling. The test for whether a default is right is
what a forgetful caller gets, and there is no reading of a label write where "GitHub refused it" should be
indistinguishable from "it was not there". Inverting the name rather than the value matters too: a future caller who
wants the old behaviour has to write `{ lenient: true }` at the site, which is a claim about intent that a reader can
check. There are no callers of `lenient` in the tree; it exists so that there can be one honestly.

**Tests.** A unit test on `makeGh` itself with a fake `exec`, covering a refused write with no options and with `{}`,
gh's three spellings of an absent label, the explicit `lenient` case, and a removal that lands. Fails pre-change on the
first assertion. Plus a tick test that wires the REAL `removeLabel` to a `gh` that refuses, which is the gap the old
tests left: every existing test of this path replaced `gh.removeLabel` with a function that throws, which proves the
tick handles a throw and proves nothing about whether the real one throws. It now drives the counter to the stop
through the real client.

## 2. The ready-label write: the fourth caller, exactly as predicted

Round seven: "If a fourth caller of `retryFailed` is ever added..." It was not added; it was already there and
uncounted. `gh.addLabel(READY_LABEL)` on the way into `ready` caught its own failure, logged, and returned. With a
token that permanently cannot write labels, the entry stayed in `pr-open` and the next tick judged the same head again:
the same reviewer verdict, the same checks read, the same completion gate evaluated, the same label refused, forever.
Worse than the other three in two ways the other three are not. Every readiness condition had already passed, so
nothing was pending except the label; and the gate is not free, so with a hosted evaluator the operator paid for a
decision that had already been made, once per poll.

**The fix.** Through `retryFailed` with `op: "ready label write"`, cleared before the state moves rather than after, so
`retry` is never set on a `ready` entry where a stale count would outrank the ready row and hide the one thing the
operator is being asked to do.

**The prediction, checked.** Round seven flagged that `retry` outranks `inFlight` on the status row and that a fourth
caller on a path running alongside a live run would hide that run. That specific interaction is not reachable and the
reasoning is unchanged: `settleRun` returns before this branch whenever a run this entry owns is alive, so an entry
cannot be retrying this write with its own run in flight. The prediction pointed at the right line for the wrong
reason. The real interaction is the row's LABEL, which was read off the state alone: a `pr-open` entry retrying
anything read `fixing`, which is true for the two removals (a fix round really does follow one) and false for this one,
where the work is finished. The row now says `blocked` for this op and `fixing` for the others. That needed one op name
shared between `tick.mjs` and `status.mjs`; it is exported from `tick.mjs`, which is the file that writes it, because
`lib/` does not import from `lib/commands/`. `why` gains a line saying the PR is otherwise ready and only the label
will not write, since the operator's action is to fix a token rather than look at the diff.

**Tests**, all failing pre-change: the bound driven to `stuck` with the ready label attempted exactly five times (and
the needs-human label once, by the stop, which is a different write); the existing single-failure test updated to
assert the count and that it never sits on a `ready` entry; the `blocked` row against the two other ops on the same
state; the `why` line.

## 3. `register`: the point of no return, put last

**What was wrong.** A reset with a new `--harness` or `--session` makes two durable GitHub writes. The body write went
first. It is the one that changes the recovery identity, since `reconcile` rebuilds an entry from the block alone once
`state.json` is gone. So a comment that then failed left `register` reporting that nothing was reset, the registry
still on the old identity, and the PR already recording the new one. A running daemon reads the registry and a later
recovery reads the block, so the two resumed different harnesses or different sessions for the same PR, and nothing
anywhere compares them.

**What was chosen, and the reasoning asked for.** The order is reversed: comment, then body. The question is which
write cannot be taken back, and the test is what each failure leaves behind.

- The comment is safely repeatable. `countRounds` takes the LAST reset marker among the daemon's own comments and
  counts the round comments after it (`events.mjs:208`), so a second marker counts exactly as one does. A duplicate is
  cosmetic.
- The body write is not repeatable in the sense that matters: its effect is not "a marker exists" but "the identity of
  record is now X". Once it lands, every reader of the block sees the new identity whether or not anything local agrees.

So the body write is the point of no return and it goes last. A failed body write now leaves a reset comment on the PR,
the registry untouched, and both sides still naming the old identity, which is a state the same command completes. A
failed comment leaves nothing durable at all. Neither failure can produce two identities. Both still throw, because
`register` is one interactive command with an operator in front of it; what changed is what GitHub is left saying. The
refusal messages now name the identity that survived, so the operator is told which harness and session the PR still
records rather than only that nothing happened.

**Test**: both halves driven, then the retry after the body write is fixed, asserting one identity on both sides at
every point and that the duplicate comment changes nothing. Fails pre-change.

## 4. The inherited session, revalidated: cleared, and said out loud

**What was wrong.** `--session` is checked against the chosen harness (`isSessionFor`, round five). An INHERITED
session never was. `--harness opencode` with no `--session` carried the old harness's id straight through, so a claude
UUID became an opencode session id. The next fix round resumed an id opencode cannot resolve, and the block written
with it was refused by `parseBlock` on the way back, which kills the recovery the block exists for.

**Cleared, not refused, and why.** The brief guessed clearing and the brief is right, but the reason is worth stating
because it is not "clearing is friendlier". A refusal is the correct answer to a value that is wrong. This value is not
wrong, it is meaningless: opencode cannot resume claude's conversation whatever that conversation is called, so there
is no id the operator could supply that would make the inherited one work. The honest result of "this harness has no
session for this PR" is no session, which is exactly the state a fresh registration is in, and the next fix round
starts one. Refusing would leave the operator with a command that cannot succeed until they pass `--session` with a
value they do not have.

What it must not be is silent, because the operator loses a conversation they may have wanted. Three things say so: the
log names both harnesses and the dropped id and says a fresh session will be started, `register` returns the session it
actually stored so no caller can report a resume that did not happen, and the block written to the PR carries the same
null so a recovery cannot restore the id that was just dropped.

An explicitly typed `--session` still refuses, unchanged. An operator who typed an id meant that id, and the right
answer to a typo is not to quietly ignore it. And a harness change between two that agree on the format, claude to
codex, keeps the session, because dropping it there would cost a conversation for nothing.

**Tests**: the drop from both sources it can be inherited from (the registry entry and the PR block), asserting the
returned value, the registry, the block, `parseBlock` reading that block back, and the log line. Plus the guard against
over-clearing: claude to codex keeps the id and logs nothing, and an explicit bad `--session` still refuses with
nothing written. The drop test fails pre-change; the keep test passes both ways and says so, since it protects a
behaviour rather than fixing one.

## 5. The tests that only passed on this laptop

**The symlink test.** It linked to `join(HOME, ".claude")` and asserted the forbidden-directory message. On an account
with no `~/.claude` the link dangles, `realpathSync` throws, `realOf` falls back to the lexical path, validation
correctly reports that the path does not exist, and the assertion fails. Verified by running the suite with `HOME`
pointed at an empty directory: it failed exactly as described.

Every target the test links to is now one the test creates. The assertion is not weakened; it is made stronger, because
the shapes are now enumerated rather than implied. `validateContextPaths` refuses a candidate when
`isInside(realOf(forbidden), candidate)`, so what the `~/.claude` case was really testing is "a link to a directory
that CONTAINS a forbidden one". The test builds that from the one forbidden entry it controls, the Gallivant home,
which the function takes as a parameter: a link to the home itself, a link to its parent, and a link to a directory
that contains the home holding the settings. The real home directory is still used for the one refusal that is about
`$HOME` itself rather than containment, which is safe because `homedir()` exists on any account the suite can run on at
all and nothing is read from it or written into it. And a dangling link is now asserted to report "does not exist",
which is the assertion that makes the accident impossible to repeat: nothing in this test can be satisfied by a link to
nowhere.

**The rest of the suite, swept as the brief asked.** Two more found, both fixed, and the brief's example of a doctor
test resolving against shared `/private/tmp` is genuinely gone (every `existsSync` and `statSync` in the suite is
against a directory the test created with `tempHome()`, and the four shared `/tmp/gallivant-test-*` paths in `CONFIG`
are string values that are never created, read or stat'd).

- **`gemini still accepts the flags the adapter passes`**, `test/units.test.mjs`. It skipped when the binary was
  absent, which is why it looked handled, and then asserted `--skip-trust` against whatever `gemini` was first on the
  PATH with no version check at all. On this machine a Homebrew gemini 0.28.2 in `/usr/local/bin` sits ahead of an
  nvm-installed one, and 0.28.2 does not have that flag and is not expected to: `MIN_VERSIONS.gemini` is `0.59.0` and
  `probe.mjs` refuses to RUN a harness below it. So the suite was failing on a build the daemon would itself refuse.
  It now reads the version the same way `probe.mjs` does and skips with the version and the minimum in the reason. A
  skip and never a silent pass: the reason names what was found and what was wanted. The same gate covers opencode and
  goose, which had the same hole and happened not to be hit.
- **`liveness asks whether the pid still runs the harness`**, `test/units.test.mjs`. It asserted
  `isOurProcess(process.pid, "/bin/claude") === false`, which holds only while no part of this process's command line
  contains the string "claude". `isOurProcess` matches `basename(cmd)` as a substring of the whole `ps` line, and the
  line carries every argv element, so a checkout path, a `HOME`, a runner root or a `--import` containing "claude"
  broke it. Found by accident: the sandbox used to simulate a clean machine lives under a directory named
  `claude-501`, and the assertion failed there. The control name is now random per run, with an assertion that it
  really is absent from this process's own command line before the negative case is asserted.

**The clean-machine run, simulated rather than assumed.** `HOME` pointed at an empty directory and `whence` stubbed to
return null for every harness, which is what "no harness binaries installed" means to every line of this code, since
`whence` is the one place the suite asks the machine what is installed. 298 tests, 0 failures, 3 skips, each naming the
harness that is not installed. Repeated from a path with no "claude" in it, to be sure the simulation was not itself
the thing under test.

## The sweeps

### 1. Every declining write, enumerated

Ten GitHub writes outside `gh.mjs`. Bounded means it counts on `entry.retry` and stops with `stuck`.

| Site | Write | Verdict |
|---|---|---|
| `tick.mjs`, `reopen` via `dispatch` | `removeLabel(READY)` | **Bounded** |
| `tick.mjs`, `reopen` via `headChanged` | `removeLabel(READY)` | **Bounded** |
| `tick.mjs`, `settleRun` leaving `running` | `setBody` (identity block) | **Bounded** |
| `tick.mjs`, the ready branch | `addLabel(READY)` | **Bounded**, this round (finding 2) |
| `tick.mjs`, `settleRun` counting a round | `comment` (round marker) | **Bounded**, this round (below) |
| `tick.mjs`, `writeStopLabels` → `removeLabel` | `removeLabel(READY)` | Deliberately lenient, documented at the site: the entry IS stopped, and `addLabel` is what the `labels_pending` retry tracks |
| `tick.mjs`, `writeStopLabels` → `addLabel` | `addLabel(NEEDS)` | Bounded by a different mechanism: `labels_pending` on the entry, retried on every tick of a stopped entry until it lands. Not counted, and correctly so: there is no worse state to escalate to |
| `tick.mjs`, the nudge | `comment` (nudge marker) | Deliberately unbounded, and defensibly: a throw goes to the per-entry catch, `rereview.nudged` is not set, so the next tick nudges again. The entry is not held: `stall_hours` still expires and stops it with `reviewer-silent`. So the wait IS bounded, by the timer that was already running. See the note below |
| `register.mjs`, `comment` and `setBody` | the reset | Neither: a command with an operator. Both throw, both ordered (finding 3) |
| `register.mjs` / `start.mjs`, `ensureLabels` | label creation | Deliberately lenient, both spellings agree: a repo convenience nothing depends on |

Two of those were unbounded when this sweep started and are not now.

**The round comment, fixed.** `settleRun`'s round comment threw to the per-entry catch, so the `save` below never ran,
`last.exit` stayed unrecorded, and the next tick re-entered the settle and tried again. Driven against the tree: eight
ticks, eight identical `errors.log` lines, `iteration` still 1, nothing stopped and nobody told. Now the fifth caller
of `retryFailed`. The comment stays a precondition of counting the round, which it already was and rightly: a count
rebuilt from GitHub is made of these markers, and `rereview.at` claims the re-review was asked, which the comment is.

Fixing it exposed two sibling defects that the fix itself would otherwise have introduced, and both are worth recording
because both are the same "one path, not its sibling" shape:

- **The decline returned `false`.** `settleRun` returns "does this entry wait". The block write's decline returns
  `false` safely, because `tickEntry` returns early on `state === running` regardless. This one leaves the entry in
  `pr-open`, so `false` let the rest of the tick run against a half-settled entry: `headChanged` advanced
  `cursor.fixed_sha` to the very head the round had just pushed, and the NEXT tick re-read the settle with `pushed`
  false and stopped the entry with `no-push` for a push that had plainly happened. Two ticks was all it took. It now
  returns `!stopped`.
- **`retryFailed` discarded `onStop.last`.** The spread was `{ ...onStop, retry: null, last: {...} }`, so a caller
  passing `last` had it silently overwritten. Nobody had passed one before. This caller must, because `last.exit` has
  to stay null WHILE retrying (it is the registry state the settle re-enters on) and must be recorded ON the stop, or
  `settleRun` keeps re-entering the branch after the entry has stopped and counts a fresh streak against an entry
  nobody is waiting on. `onStop.last` is now merged; `event` and `at` remain `retryFailed`'s to write.

**The nudge, examined and left alone.** It is the one remaining write in the tick with no counter, and that is right
rather than an oversight. Every other unbounded wait this document has named had the property that nothing else would
ever move the entry. The nudge does not: the silence timer it exists to serve keeps running, and `stall_hours` stops
the entry with `reviewer-silent` whether or not the nudge was ever posted. A counter would stop the same entry sooner
with a less useful reason. Recorded so that a later sweep does not "fix" it into a sixth caller.

### 2. Booleans that default to the unsafe value

Finding 1's shape, hunted deliberately. Every defaulted option in `lib/`:

- `gh.mjs` `removeLabel`, `{ lenient = false }`: was the instance. Now safe by omission.
- `doctor({ send = false, probe = false })`: both default to the INERT value (no notification sent, no live harness
  session run). Safe direction, and there is one caller, which passes both from argv.
- `makeContext({ needConfig = true })`: defaults to doing MORE validation. Safe direction.
- `status`/`render` `{ all, json }`: display only.
- `buildRun({ contextPaths = [] })`: defaults to granting nothing. This is the one where the wrong default would be a
  real security hole, and it is right.
- `deliverable` limits (`scan_output`, `require_summary`, `require_tests_passing`, `on_unreachable`): every one
  defaults to the strict value in `DEFAULT_DELIVERABLE`, and `merge` folds an operator's partial `deliverable` over
  those defaults key by key, so omitting one in `config.json` gets the strict value rather than disabling the check.
  Verified by reading `config.mjs:178`.
- **One reported, not changed: `ready({ checkOnly = false })`.** Omitting it gets the side-effecting behaviour: the
  PRD's `status` is set to `ready` and the file is written. It has exactly one caller, `bin/gallivant.mjs:56`, which
  always passes `checkOnly: values.check` from argv, so it cannot be got wrong by omission today. It is named here
  because it is the same shape as finding 1 and the same argument applies if a second caller ever appears: the
  dangerous half should be the one you ask for.

### 3. What these fixes make newly possible

Answered per change, as every round since the fourth has.

**Finding 1, `removeLabel` strict by default.** Newly possible: `writeStopLabels` now sees throws it used to see too
(it already passed `strict`), but `reopen` now throws where it previously resolved, which means both its callers can
decline where they previously proceeded. That is the fix, and it is the intended new behaviour. The second-order
effect is a rate change on an existing path: `headChanged` on a `ready` entry now declines and counts where it
previously judged the new head with a stale label, so during a GitHub outage a `ready` entry whose head moves reaches
`stuck` in five ticks rather than silently mislabelling. That is louder than before, which round seven already
identified as the trade this mechanism makes. Third: nothing else in the tree calls `removeLabel`, so there is no
caller that was relying on the swallow. I checked.

**Finding 2, the ready-label write bounded.** Newly possible, and this is the one I would watch: a PR that has passed
every readiness condition can now STOP instead of waiting. The operator is told `stuck` about a PR that is, by every
other measure, finished and mergeable by hand. The label is the only thing missing, and a person who goes to the PR can
merge it. That is strictly better than the old silence, but it is a new way for a finished PR to appear in NEEDS YOU
with a reason that is not about the PR, so the row says `blocked` and `why` says the PR is otherwise ready. Also newly
true: the completion gate is no longer re-evaluated indefinitely on this path, which for a hosted evaluator is a real
cost reduction and, less obviously, means a gate decision that WOULD have flipped (a passport change, an APort policy
edit) is no longer picked up by the accidental re-evaluation. Nothing depended on that, because a gate re-evaluation
that flipped to deny would have started a receipt round from a `pr-open` entry that was one label away from ready,
which was never intended behaviour. I am satisfied it was accidental rather than load-bearing, but it is a behaviour
that existed and no longer does.

**Finding 3, the write order in `register`.** Newly possible: a reset can now leave a reset comment on a PR that was
not reset, where before it could leave a rewritten identity block on one that was not reset. Both are litter; the
difference is that a stray marker is read by `countRounds`, which takes the last one, and a stray identity is read by
`reconcile`, which believes it. So the litter is now the harmless kind. Second-order, and I want it on the record: the
comment is posted before the body write, so an operator who runs `register --harness codex` against a repo where the
token can comment but not write bodies now gets a reset comment on every attempt. Five attempts, five markers, and
`countRounds` still reads one boundary. Noisy on the PR, correct in the count.

**Finding 4, the session cleared.** Newly possible: a `--harness` change can now silently cost a resumable
conversation, in the sense that the operator did not ask for it to be dropped. It is logged and returned, which is the
mitigation, but a log line is weaker than a refusal and an operator running `register` in a hurry may not read it.
The alternative was a command that cannot succeed, which I judged worse. Second-order: `chosenSession` can now be null
where the block had a value, so the block is rewritten (the `stale` check compares `block.session !== chosenSession`)
on a reset that the operator may have thought was only about the harness. That is correct, since the block must not
keep an id the entry no longer has, but it means finding 3's ordering is now reached by a case that did not reach it
before: a harness change across incompatible formats always writes the body.

**Finding 5, the tests isolated.** Newly possible: the harness flag checks can now be skipped on a machine where they
would have run, if `--version` reports something older than `MIN_VERSIONS` or will not report at all. That is a real
loss of coverage on exactly the machines where an upstream flag rename would bite, and the honest statement is that
this trades a false failure for a possible silent gap. The skip reason names the version so the gap is visible in the
output rather than implied, which is the best I can do without pinning a harness version the project does not install.
For the symlink test I can see no new risk: it asserts more shapes than before and every target is one it creates.

**The round comment bounded.** Newly possible: a round that pushed can now end with the push on GitHub, the fix in the
branch, and the entry stopped with `stuck` and `iteration` NOT incremented. The work is not lost (it is pushed) and the
round is not counted, so a `register` reset followed by another round is charged from the same iteration. That is a
free round from the budget's point of view, which I believe is the right side to err on for a round the daemon could
not announce, but it is a case where `iteration` and the work actually done disagree. Second-order: `last.exit` is now
recorded on this stop and not on the retries, which is the distinction `settleRun` re-enters on, so anything that reads
`last.exit` as "the run is finished" is correct for the first time on this path.

**`retryFailed` merging `onStop.last`.** Newly possible: a caller can now shape the `last` a stop records. Only one
does, and `event` and `at` are still written by `retryFailed` itself, so the field the operator reads cannot be
overridden by a caller. A caller that passed `last.event` would have it silently ignored, which is the same class of
trap in the other direction; it is noted here rather than guarded, because there is no caller and a guard for a
hypothetical one is harder to read than the four lines it would protect.

## What I would look at next

Not fixed, named, in the order I would rank them.

1. **`iteration` and the work done can disagree**, on the round-comment stop above. It is the only place in the tree
   where a pushed round is not counted, and whoever owns the budget story should decide whether a stop like that should
   count the round it could not announce.
2. **`ready({ checkOnly = false })`**, the last boolean whose omission is the side-effecting half. One caller today.
3. **The nudge has no counter, on purpose.** The reasoning is in the table above. It belongs on a list of things a
   later sweep will want to "fix", so it is on this one.
