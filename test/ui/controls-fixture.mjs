import { NOW, TASK } from "./fixture.mjs";

// Synthetic coordinator observations. Never applied to a real task or provider.
export const CONTROL_NOTE = "Keep the existing search index until the migration is verified. Preserve the rollback path and the current task context.";
export function settleControl(world, status, message = "Synthetic coordinator result.") {
  return world.state.update(TASK, { control: { ...world.state.get(TASK).control, status, message, started_at: NOW,
    ...(["applied", "failed"].includes(status) ? { finished_at: NOW } : {}) } });
}
