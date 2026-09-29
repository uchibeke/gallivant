---
status: ready
harness: claude
aport_decision: d2bbf146-c662-4da0-8f25-b02b5bd470a9
---

# Deliver a message to a session already at work

## Problem

Gallivant's promise is that you write a brief, mark it ready, and go outside. The going-outside half works
and the coming-back half does not. Once the daemon is ticking, the only way to change what a session is doing
is to be at the keyboard, so the operator either stays there, defeating the product, or leaves and learns
hours later that a session spent forty minutes on the wrong thing.

Steering was assumed impossible because runs are spawned with stdin closed: `lib/run.mjs` passes
`stdio: ["ignore", out, out]` and the prompt travels in argv. It is not impossible. The harness accepts
streaming input on stdin in the same print mode Gallivant already uses, and a message sent that way arrives
at the next tool-call boundary, in the same session, with the turn's finished work preserved. Measured on one
harness: a four-step tool sequence redirected after the first step, and the remaining three never ran.

That matters beyond convenience. A run killed at 31 minutes had finished a whole review round and was writing
its commit message; the only lever available was a kill that threw the round away. A message that lands at a
tool boundary is the lever that was missing.

This brief builds the delivery mechanism and nothing that carries messages to it. Writing to the pipe is a local
command, so the mechanism is testable and useful before any transport exists.

## User stories

- As an operator watching a session go the wrong way, I want a correction that lands in seconds rather than
  at the end of its turn, so that I stop paying for work I will throw away.
- As an operator at my terminal, I want one command that speaks to a named run, so that steering works
  before any remote channel is built.
- As an operator running codex or goose, I want a message to reach the session eventually rather than be
  silently dropped, so that my harness does not decide whether steering exists.
- As an operator stopping a run, I want it to commit what it finished first, so that stopping is never why
  work is lost.

## Acceptance criteria

- Given a run spawned by the daemon, when it starts, then its stdin is a named pipe the daemon holds open for
  writing, the harness gets its streaming-input flag, and the run behaves exactly as before when nothing is
  ever written to that pipe.
- Given a detached run whose daemon is not attached to it, when a message is written to its pipe, then the
  write succeeds and the session receives it, so the pipe never closes on end of file mid-run.
- Given a run midway through a multi-step tool sequence, when a message is written to its pipe, then it
  arrives at the next tool-call boundary in the same session, the work already finished in that turn is
  preserved, and the run log records it arriving.
- Given a harness whose command line has no streaming-input flag, when a message is sent to one of its runs,
  then it is queued for the next run's prompt, and the entry records that it is queue-only.
- Given the say command called with a handle and a message, when that handle names a live run on a harness
  that supports streaming input, then the message is written to that run's pipe and the command reports it
  delivered.
- Given the say command naming an entry with no live run, when it is called, then the message is queued for
  the next run and the command says so rather than reporting a delivery that did not happen.
- Given a message that was queued rather than delivered, when the next run starts, then the prompt carries it
  quoted as data, and the queue is emptied only once the run has been spawned.
- Given a stop for a named run, when it is processed, then the session is asked to commit its finished work
  first, and the entry records how many files were committed and how many were left.
- Given a stop for a run that already ended, when it is processed, then it succeeds and changes nothing.

## Verify

- `npm test`
- `npm run lint`

## Where to look

- `lib/run.mjs` spawns with `stdio: ["ignore", out, out]`: the one word to change. Its comments on detached
  processes matter, because the pipe must survive the daemon not being attached.
- `lib/harness.mjs` builds argv per harness and holds `assertSafeArgv`. The streaming-input flag goes beside
  the print flag per adapter, and a harness without one says so rather than pretending. `contextSupport` is
  the pattern for reporting a per-harness capability honestly.
- `lib/prompt.mjs` quotes untrusted text in a fence and appends its rules after. A queued message is quoted
  the same way.
- `lib/git.mjs` has `dirty()`, which counts what a stop would leave behind.
- `lib/commands/resume.mjs` already takes a `note` that reaches the session through `resumePrompt`. A queued
  message is the same shape and should not grow a second path.

## Out of scope

- Any transport. No Telegram, no web route, no network listener. The local command is the only writer here,
  and the channel that calls it is a separate brief.
- Mid-turn steering for harnesses without streaming input. Those queue, and the entry says so.
- Redacting or bounding what the operator types. A local command types what the operator means.
- Changing what the completion gate judges. It reads the daemon's snapshot and keeps doing so.
