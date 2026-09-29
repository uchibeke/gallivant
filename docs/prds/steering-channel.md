---
status: ready
harness: claude
aport_decision: 9aefb255-6559-413d-a9b9-95cd7a7390aa
---

# Carry a steering message from a phone to a run

## Problem

A session can now be told something mid-turn: a message written to its stdin pipe arrives at the next
tool-call boundary with finished work preserved. But the only writer is a local command, so the operator has
to be at the keyboard, which is the situation that made steering worth building.

What is missing is a channel the daemon can read while the operator is out. The constraint that shapes it is
that no inbound port may be opened and nothing may be self-hosted, so the daemon polls rather than listens.
Long-polling transports satisfy this: the daemon holds an outbound request and a message arrives in about a
second, with no webhook and nothing reachable from the internet.

The security shape matters more than the transport. A steering message becomes part of a prompt to an agent
holding a push token and a shell, so anyone who can write to the channel is performing prompt injection with
real reach. The existing design already answers this for GitHub comments: the daemon judges against its own
snapshot of the brief, never the copy a session can edit, so a session cannot widen its own contract. A
message must get the same treatment, and for the same reason.

This brief depends on `docs/prds/run-stdin-steering.md`, which builds the pipe and the local writer. Start
this one only after that has merged: there is nothing here to deliver a message to until it has.

## User stories

- As an operator away from my machine, I want to steer a run from my phone, so that leaving the house does not
  mean losing the ability to redirect work.
- As an operator whose phone is not the keyboard, I want the channel to refuse anything widening a brief or
  weakening a guardrail, so that a lost phone is an inconvenience rather than a breach.
- As an operator sending a message, I want to be told which run it reached and whether it was delivered or
  queued, so that silence is never mistaken for success.
- As an operator whose channel is down, I want the daemon to say so, so that an unanswered message is never
  read as one that landed.

## Acceptance criteria

- Given the channel is configured, when the daemon ticks, then it reads pending messages over an outbound
  request with no listening socket opened and no inbound connection accepted.
- Given a sender not on the configured allowlist, when they send anything, then the daemon ignores it, records
  the attempt with the sender identifier and no message body, and replies nothing that would confirm the
  channel exists.
- Given a message arriving twice with one transport identifier, when the second is processed, then it is
  refused as already handled and nothing is delivered twice.
- Given a message older than the configured freshness bound, when it is processed, then it is refused with its
  age named, so a delayed or captured message cannot be replayed into a changed situation.
- Given a message that names no run, when it is processed, then it is refused rather than applied to whichever
  run happens to be current.
- Given a message the daemon accepts, when it acknowledges it, then the reply names the entry and run it
  reached and whether it was delivered or queued.
- Given a message rendered into a prompt, when the prompt is built, then the message is quoted as data in a
  region whose delimiter it cannot predict, with bidirectional and zero-width characters stripped, and the
  prompt says a message cannot change the brief, widen scope or alter a guardrail.
- Given a message asking for the brief to change or a guardrail to relax, when the session acts on it, then
  the snapshot and fingerprint are unchanged and no path from the channel handler reaches their writers.
- Given any message accepted or refused, when it is processed, then an append-only record holds the time, the
  sender, the target entry and run, the transport identifier and the decision, with a hash and length of the
  body but not the body.
- Given the channel is unreachable, when the daemon polls it, then it records the outage, keeps ticking, and
  the status output says the channel is down.
- Given the channel credential, when a run is spawned, then it is absent from that run's environment, because
  a session can read its own environment and must not be able to read or write its own steering channel.

## Verify

- `npm test`
- `npm run lint`

## Where to look

- `lib/events.mjs` already solves replay for GitHub: an inclusive boundary, a dispatched key set, `eventKey`,
  and `makeTrust`'s constructor that throws rather than trusting nobody. Reuse that design.
- `lib/prompt.mjs` quotes untrusted text in a fence and appends its rules after it. Its header says quoting is
  hygiene rather than a control; keep the honesty and the ordering.
- `lib/notify.mjs` is the outbound half and its header says bodies never carry diff or comment text. Same rule
  for what the channel may send back.
- `lib/git.mjs` has `runEnv`, which the channel credential must never join, and explains why nothing outside
  the worktree is named in it.
- `lib/config.mjs` holds defaults and validation. An invalid channel config fails at load, not first use.
- `lib/commands/up.mjs` is the tick loop, which is where a poll belongs.
- `SPEC.md` lists a chat interface as a non-goal and records that an earlier bot was ignored for streaming
  everything. Update both rather than leaving the spec contradicting the code.

## Out of scope

- Streaming log lines over the channel. Chat transports cap message size and rate, and an earlier bot was
  ignored for streaming everything. The channel carries short messages and a link.
- More than one transport. One implementation behind a small interface, chosen in config, so a second can be
  added later without a second code path now.
- A web write route, its authentication, and serving the tracker off loopback. A separate brief.
- Starting a run, registering or removing an entry, touching a worktree, editing config or running git.
- Remote resnapshotting. Making an edited brief the brief stays a command typed at the machine.
- Redacting log content so a third party's channel can carry it. There is none today and a pattern-based one
  would not be trustworthy.
