---
status: ready
harness: codex
---

# Synthetic qualification fixture

## Problem

This synthetic brief gives the dependency plan examples a local file for the
join after the console group. A reader can inspect the normalized graph and see
two incoming edges to this leaf, one from each of the plan view and task view
leaves in the group.

## User stories

- As a fixture reader, I want a qualification brief, so that I can inspect the join.

## Acceptance criteria

- Given the synthetic manifest, when it is validated, then the qualification
  leaf resolves to this file.

## Verify

- `node -e "process.exit(0)"`

## Where to look

- none

## Out of scope

- Qualification or execution of a real delivery workflow.
