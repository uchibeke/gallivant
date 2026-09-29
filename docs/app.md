# The app, and what Gallivant should not become

Gallivant is a daemon and a CLI. This document records three decisions about what it grows into: a UI worth
building, a BYOK story worth building for a reason other than the obvious one, and an agentic loop not worth
building at all. Nothing here is implemented. It exists so the next person to ask "should Gallivant just be the
whole thing?" can read the reasoning instead of rederiving it.

The short version: build the browser app, treat BYOK as a compliance feature rather than a cost feature, and do not
write a harness.

## 1. Do not write a harness

Gallivant owns orchestration. It watches a pull request, decides when to resume, gates on the PRD contract, bounds
the retries, and keeps four cursors and a state machine honest. The harnesses own the agentic loop: tool design,
context management, applying an edit, prompt caching, and a long tail of small recoveries. Five adapters of a few
hundred lines each buy all of the second thing.

The argument for writing our own loop is that it would remove a dependency. The argument against it is the bug list
from the thin layer that merely wraps someone else's loop:

- `--add-dir` is variadic, so context flags appended after the prompt swallowed it. The flags had to move to the
  front of argv, and an existing test had encoded the broken order as the contract.
- `GIT_CONFIG_GLOBAL` alone does not isolate git. The Xcode command line tools ship a system gitconfig setting
  `credential.helper = osxkeychain`, so a run had a path to the operator's keychain until `GIT_CONFIG_NOSYSTEM=1`
  was added.
- A jq expression computed `1500/1000` as `1.5` where an integer was required, which denied every tool call in the
  guardrails hook until it rounded up.

None of those three are loop problems. They are the problems of the wrapper. The loop itself is where the teams
building Codex and Claude Code spend all of their time, and starting that race now means starting it years late
while giving up the position Gallivant already holds.

That position is worth naming, because it is the actual asset: Gallivant outlives harness churn. When the next
harness ships, it gets an adapter. The five adapters are the proof, not the overhead. A product that is "yet
another agent loop" throws that away and competes on the one axis where it is weakest.

So: no. The adapter boundary stays where it is.

## 2. BYOK is a compliance feature, not a cheaper subscription

The tempting version of BYOK is "get Codex and Claude Code features without the frontier lab subscription." That
one does not work, and it is worth being precise about why: those features are not the model. The subscription pays
for the loop, the caching that makes a long session affordable, and the server-side machinery around both. Point
raw API keys at a loop of your own and the result is a worse loop at metered prices.

For the runs Gallivant actually produces, metered is usually the more expensive option, not the cheaper one. One
fix round on `aporthq/agent-passport` spent 31 minutes across twelve verify invocations, a full Codex review round
with mutation testing, and a proof that one failing test was pre-existing. The resume before it ran 7.3 hours. That
shape of work is what a subscription is priced for and what cache-naive metering punishes.

There is a real BYOK need underneath, and it is a different need: operators who *cannot* use a subscription.
Enterprise procurement that forbids it, data residency requirements, or an existing Bedrock or Vertex contract that
the spend has to flow through. That is a genuine market, and it is about where the bytes go and who holds the
contract, not about the bill being smaller.

Building it for "cheaper" disappoints everyone, because it will not be cheaper. Building it for compliance is
honest and might already be nearly free.

**What to check before writing anything.** Several harnesses already accept an operator's own key or a cloud
endpoint. If the compliance case is satisfiable by configuring the existing adapters and documenting which
harness reaches which provider, then BYOK is a `docs/` change and a `gallivant doctor` check rather than a feature.
That is the version to explore first, and it should be settled before any code is considered.

## 3. Making money without owning the loop

BYOH (bring your own harness and subscription) is the current model and it should stay the default. It is why
Gallivant works at all: five adapters, each one a `{cmd, args, env}` triple and nothing more, so a new harness is a
few hundred lines and a version probe. The operator keeps the subscription they already pay for.

The problem BYOH has is not technical. It is that a tool which requires you to already own a Claude Code or Codex
subscription only sells to people who have one, and it captures none of what they spend. So the monetization
question is real, and the cheap harnesses are the interesting lever.

**The observation.** There are now harnesses an order of magnitude cheaper. OpenCode is already an adapter.
Command Code (https://commandcode.ai) is the one worth looking at closely, because its plans start at $1/month with
$10 of credits and its $10/month tier carries up to $70 of per-model allowance. Its pitch is open models, and its
model list also includes closed ones.

Its CLI is a close match for the adapter Gallivant already has for Claude Code, which is what makes this concrete
rather than speculative. Installed with `npm i -g command-code`, invoked as `cmd`, and in headless mode:

```
cmd -p "prompt"                                # single prompt, non-interactive
cmd -p "prompt" --output-format json           # newline-delimited JSON, one object per line
cmd -p --resume <session-id> "continue"        # resume an exact session
cmd -p --continue "follow-up"                  # resume the most recent
cmd -p --permission-mode dont-ask              # fail-closed allowlist, for CI
```

Four of the five things an adapter needs are there: a print flag, NDJSON output for the log pane to parse, resume by
session id, and a non-interactive permission mode. It also has `PreToolUse` hooks and a
`.commandcode/settings.json` with `permissions.allow` / `permissions.deny` rules, which is the same shape the APort
guardrails already hook into for Claude and Codex.

Its `--permission-mode dont-ask` is documented as a fail-closed allowlist rather than an auto-approve, which is a
better default than several of the harnesses already supported. It also offers `--yolo` and
`--dangerously-skip-permissions`, and both are already refused by `assertSafeArgv` without any change:
`--yolo` is in `DANGEROUS_FLAGS` and the `/^--dangerously-/` prefix test catches the other. That the existing
guard covers a harness it was never written for is the argument for the adapter boundary in section 1, restated.

**Two gaps to verify before writing an adapter.** The docs did not show a way to *choose* a session id up front
(Claude Code's `--session-id`), only to read one back with `--verbose` and resume it. Gallivant records the session
it started, so reading the id from the first run's output would work, but it is a different code path from the one
the Claude adapter uses. And no `--add-dir` equivalent appeared, which is what the optional read-wide context dirs
rely on; `contextSupport(harness)` already returns `none` for harnesses that cannot do it, so this degrades rather
than blocks.

Neither gap is disqualifying. Both should be confirmed against the actual binary rather than the docs, because the
`--add-dir` argv-order bug in section 1 is exactly the kind of thing docs do not tell you.

**The question to answer first.** Whether a cheaper loop is good enough for Gallivant's work. That work is narrow
and repetitive: read a brief, satisfy acceptance criteria, answer a reviewer, fix a failing check. It is a far
smaller ask than open-ended agentic coding, so the bar may well be clearable.

It is answerable with the tool as it stands: **run the same brief on a cheap harness and a frontier one and
compare.** Rounds to green, reviewer findings per round, and how often a run stops with `needs-human` rather than
`ready-for-human`. Gallivant already records all three (`iteration`, the round comments, the stop reason), so the
experiment costs a few runs and no code. If a cheap harness needs five rounds where Claude Code needs two, the
bundle is a worse product at a lower price and the idea dies cheaply. If it needs three, there is a business.

### Shapes, worst to best

**Resell the harness.** Gallivant bundles a subscription to a cheap harness and marks it up. This is the obvious
one and the weakest: margin on someone else's product, a support burden for a loop we do not control, and a
business that dies when that provider changes their pricing. It also puts Gallivant in the position of defending a
loop it did not write, which is the thing section 1 exists to avoid.

**Hosted Gallivant, BYOH still.** Gallivant runs the daemon, the operator still brings a harness subscription. This
is the honest version of what Gallivant already is: the value sold is the orchestration, the watching, the state
machine, the notification that arrives once rather than forty times. It charges for what we actually built.

What is worth charging for here is the thing the CLI cannot give: continuity. A daemon on a laptop stops when the
laptop sleeps, which is exactly what happened to the run that sat stopped for hours. A hosted daemon watches a pull
request overnight, and "go outside" becomes literally true rather than aspirational.

**Tiering on the harness, not the model.** The free tier runs whatever harness the operator has configured. A paid
tier adds a bundled cheap harness for people who have no subscription at all, sold as "you do not need one," which
is a genuinely different customer from the one BYOH reaches. Frontier harnesses stay BYOH forever, because
reselling them is a race to zero margin against the labs themselves.

**Routing, which is the version only Gallivant can build.** Different work in one brief wants different loops.
Writing the implementation is the expensive part; answering a reviewer nit, rerunning a flaky check, rebasing onto a
moved base, or fixing a lint failure is not. Gallivant already knows which of those it is doing: the tick
distinguishes a review finding from a failing check from a head change, and `dispatch`, `retryFailed` and
`fixOrStop` each name their case.

So a brief could run its first round on a frontier harness and its fix rounds on a cheap one, and the operator would
see one PR. That is a real cost reduction rather than a markup, it needs no new loop, and nobody who only ships a
harness can build it, because it requires exactly the orchestration layer Gallivant owns. Section 6.6a already
specifies per-brief model selection; per-round harness selection is the same idea one level up.

It is also the point where the read-wide/write-narrow design earns its keep: a cheap harness answering a reviewer
nit needs less trust than a frontier one implementing a brief, and the permission model is already per-run.

### What to build, and in what order

Nothing yet. The sequence is:

1. **Measure.** Same brief, cheap harness against frontier, comparing rounds to green and stop reasons. No code.
2. **Hosted BYOH**, if the measurement says the cheap loops are usable at all. Continuity is the thing worth paying
   for and it does not depend on the answer.
3. **Per-round harness routing**, which needs the measurement to say which rounds are safe to downgrade.
4. **A bundled cheap harness**, last, and only if there is evidence that "no subscription needed" reaches customers
   BYOH does not.

Do not resell a frontier subscription at any point.

## 4. The app

This is the one worth building, and most of it exists.

**What is already here.** `gallivant serve` runs an HTTP surface on 127.0.0.1. `lib/tracker/` renders the
dashboard, the run list and the run page. `lib/tracker/stream.mjs` streams a run's log over SSE with a 400-line
tail, `Last-Event-ID` resume and a `skipped` frame, and `GET /api/run/history?before=<line>` reaches back through
the rest of the run. `mount(ctx, {base})` exists so another server can delegate a path prefix to it. A CSP is set,
and `frame-ancestors` deliberately permits localhost framing because sitting inside a larger dashboard is a case
the tracker was built for.

So the daemon is already the app's backend. What is missing is not architecture.

Note that `SPEC.md` section 6.13 still says "Gallivant has no UI code." That was true when it was written and is
not true now. The spec should be corrected rather than left to contradict the tracker.

**Browser first.** It is built, it costs nothing to keep, and it is the version that can be used tomorrow. The gap
is polish and a small number of write paths: starting and resuming from the page instead of a terminal, editing a
brief, and wiring notifications to something a person actually watches.

**Native later, and yes, in TypeScript.** Tauri wraps a system webview in a small Rust shell and ships a binary of
a few megabytes; Electron bundles Chromium and is heavier but has fewer sharp edges. For a product that is already
a local server with a web UI, either one is a wrapper rather than a rewrite. What the wrapper buys is a dock icon,
real notifications, and launch at login. Those are conveniences, not capabilities.

The order matters: ship the browser version, use it for a month, and let the friction name the wrapper's job. A
native shell built before that is guessing at which conveniences matter.

## 5. The threshold the UI crosses

Every route in `lib/commands/serve.mjs` is a `GET`, and the routing table is keyed on `"<method> <path>"`, so a
POST cannot fall through to a GET handler. The tracker is read-only by construction, not by convention. That is
why it is safe to leave bound to a loopback port and safe to frame in another dashboard.

A start button ends that property. A UI that can start a run is a UI that can spend money, push commits, and open
pull requests, reachable by anything that can make a request to that port. The CLI's friction has been doing
quiet safety work: `gallivant start` is typed by a person who has just read a brief.

This is not an argument against the button. It is an argument about order. Before the first write route:

- The PRD gate has to hold on the request path, not only in the CLI. A brief still becomes the contract by passing
  `gallivant ready`, and a write route must not be a way around it.
- The guardrails have to be in place rather than pending. `gallivant doctor` currently reports no active ruleset on
  `aporthq/agent-passport`, which means the rule bounding a push away from the default branch is not enforced. A
  one-click start against an unguarded repository is the wrong first user of a new write path.
- The run credential should be scoped to what a run needs. A classic token carrying `gist`, `read:org`, `repo` and
  `workflow` is more than a fix round requires.
- The port is loopback and the CSP is strict, and neither is authentication. Anything on the machine can reach an
  unauthenticated write route.

None of these block the read-only UI, which can be improved as much as it deserves today. They block the button,
and they are the reason the button comes second. A hosted daemon raises every one of them from a local question to
a multi-tenant one, which is the other reason section 3's hosted tier is not a small step.

## 6. Order

1. **Browser app.** Highest value, lowest risk, mostly built. Read-only improvements need none of the work in
   section 4.
2. **BYOK by configuring the existing adapters.** Cheap, and it addresses the need that is real.
   Separately, **measure a cheap harness against a frontier one** (section 3), which also costs no code.
3. **Write routes**, once section 5 is closed.
4. **Native wrapper**, once a month of using the browser version has said what it is for.
5. **A harness of our own.** No.
