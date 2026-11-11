// Revision-only actions have no editable payload. Their identity names exactly
// one service action against one saved contract; it cannot approve a newer one.
export function intakeRevisionOperation(action, taskId, revision) {
  return `${action}_${taskId}_${revision}`;
}
