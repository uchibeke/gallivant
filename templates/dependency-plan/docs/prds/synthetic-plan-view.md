---
status: ready
harness: codex
---

# Synthetic plan view fixture

## Problem

This synthetic brief gives the dependency plan examples a local file to resolve
for the plan view leaf. A reader can validate the example from a source checkout
or installed package and see how this leaf participates in a fork and join with
the task view and qualification leaves.

## User stories

- As a fixture reader, I want a plan view brief, so that I can inspect its leaf.

## Acceptance criteria

- Given the synthetic manifest, when it is validated, then the plan view leaf
  resolves to this file.

## Verify

- `node -e "process.exit(0)"`

## Where to look

- none

## Out of scope

- Implementation or execution of the plan view.
