---
status: ready
harness: claude
aport_decision: a7279652-354c-4cbd-9ac2-4326372705f2
---

# Carry a brief's supporting files into the checkout

## Problem

A brief often depends on documents beside it: a requirements file, a prior design, an AGENTS.md the
repository expects. Gallivant copies the brief into the session's checkout and nothing else, so those
documents are absent from the one directory the session can read, and the operator finds out only when the
run stops.

That happened on a live run against `uchibeke/wealth-experiments`. The session checked the tree, asked
GitHub directly, and stopped naming the three files it could not find. It behaved correctly and the run was
still wasted. Worse, the agent that wrote that brief added a clause requiring the documents to be on remote
`main` first, which the operator never asked for. An implementation gap became a contract term harder to
satisfy than the work.

The existing escape hatch does not reach: `context_paths` grants reads outside the worktree, but
`contextSupport` refuses for codex and gemini and is a no-op for opencode and goose, so it works for one
harness in five. Copying files into the checkout needs no flag from any harness.

When this ships, a brief names the files it depends on, they travel with it, and a missing one is refused by
`gallivant ready` rather than thirty minutes into a paid session.

## User stories

- As an operator whose brief cites documents beside it, I want those documents named in the brief and
  carried into the checkout, so that the session can read them without me pushing them to a remote first.
- As an operator who mistypes a path, I want the refusal at my terminal when I mark the brief ready, so that
  I do not pay for a session that stops on a missing file.
- As an operator running codex or goose, I want carried files to work as they do on claude, so that my
  harness does not decide which briefs are possible.
- As an operator reading someone else's brief, I want the files it carries named in the brief, so that I can
  see what travels with it without reading the tool's source.
- As an operator whose carried file changed after the run started, I want the refusal a changed brief gets,
  so that the session and the gate never judge different contracts.

## Acceptance criteria

- Given a brief whose frontmatter names supporting files, when it is checked, then each path is resolved
  against the operator's own checkout, and one that does not exist or cannot be read is refused by name.
- Given a path that escapes the checkout, or is absolute, or is a glob, when it is checked, then it is
  refused, and the message says only files inside the checkout, named one at a time, are carried.
- Given a brief naming a supporting file, when it is marked ready, then that file's content and hash are
  recorded beside the brief's snapshot, by the same writer that records the brief.
- Given a run starting from a brief with supporting files, when the checkout is prepared, then each file is
  written into it at the path the brief named, with the same permissions the brief's own copy gets.
- Given a supporting file that changed between ready and start, when the run is about to start, then it is
  refused, the file is named, and nothing is spawned.
- Given a supporting file that changed while an entry was stopped, when it is resumed, then the refusal is
  the one a changed brief gives, and the flag that accepts an edited brief accepts the edited file.
- Given a session that edits a carried file in its checkout, when the completion gate runs, then the gate
  reads the daemon's snapshot rather than that copy, so a session cannot widen what it was given.
- Given a run whose checkout has carried files, when the session is handed its prompt, then the prompt names
  each one and says it is part of the brief rather than work to be done, so a session never mistakes a
  carried document for something it is being asked to write.
- Given a brief naming no supporting files, when any of the above runs, then nothing changes about how it is
  checked, started or judged.
- Given `gallivant why` on an entry with carried files, when it prints, then it lists them and says which,
  if any, have changed since the snapshot.

## Verify

- `npm test`
- `npm run lint`

## Where to look

- `lib/prd.mjs` holds `RULES` and `ensurePrdSnapshot`. Rules are data so `ready --check` prints them as a
  checklist, and a rule may scope itself with `kinds`. Extend the snapshot writer rather than sitting beside
  it: its comment names "one writer" as what keeps a third copy from appearing.
- `lib/sources/prd.mjs` already resolves `checkout` and `relPath` for the brief. Supporting paths resolve
  the same way against the same checkout, so nothing new has to be discovered.
- `lib/config.mjs` has `parseContextPathsMeta`: the pattern for reading a list out of frontmatter and
  refusing a malformed one. Read why it refuses what it does before writing the new parser.
- `lib/commands/start.mjs:117` writes the brief into the worktree with 0o644/0o755 and says why those modes
  rather than daemon-state modes. Carried files are the same kind of file and take the same path.
- `lib/prd.mjs`'s divergence functions and `lib/commands/resume.mjs` implement refusing a changed brief and
  accepting one deliberately. A changed supporting file is the same event; extend that comparison rather
  than adding a second one.
- `lib/harness.mjs` has `contextSupport`, reporting `grant`, `refuse` or `none` per harness. Its codex
  refusal explains that `--add-dir` makes a directory writable, which is why copying is the answer here.
- `docs/config.md` documents `context_paths`. Say how the two differ: one grants reads outside the worktree
  where the harness can, the other puts named files inside it on every harness.

## Out of scope

- Globs, directories and recursive copies. A glob is how a brief accidentally carries a `.env`, so files are
  named one at a time and the brief says exactly what travels. Directories stay `context_paths`' job.
- Replacing or deprecating `context_paths`. Read-wide access to a tree the session does not own is a
  different need, and the harnesses that support it keep it.
- Carrying files back out to the operator. The PR branch is how work returns.
- Deciding whether a session commits the carried files. Gallivant puts them in the checkout and says what
  they are; whether they belong in the branch depends on the brief. One that should be committed is one the
  operator can commit themselves, since it is already in their tree.
- Making a repository whose code lives only on a laptop work. This carries documents a session reads, and is
  not a substitute for pushing a project.
- Binary files. Text only, so a hash mismatch can name what changed.
- Any change to what the completion gate judges. It reads the snapshot today and keeps doing so.
