---
status: ready
harness: codex
---

# Synthetic task view fixture

## Problem

This synthetic brief gives the dependency plan examples a second local file to
resolve in the parallel console group. It lets a reader verify that both views
depend on the foundation anchor and that the qualification leaf needs both
views before its prerequisites are satisfied.

## User stories

- As a fixture reader, I want a task view brief, so that I can inspect its leaf.

## Acceptance criteria

- Given the synthetic manifest, when it is validated, then the task view leaf
  resolves to this file.

## Verify

- `node -e "process.exit(0)"`

## Where to look

- none

## Out of scope

- Implementation or execution of the task view.
