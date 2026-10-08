// Portable wake-up envelope. It adds exclusion/scheduling, never task decisions.
import { deliveryError } from "./task_delivery_contract.mjs";
export function createCoordinator({ store, advance, schedule, clock = Date, intervalMs = 10000 }) {
  if (!store?.withOwner || typeof advance !== "function" || typeof schedule !== "function" || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw deliveryError("COORDINATOR_CONFIG", "Inject durable fenced ownership, canonical advance, clock and wake-up scheduling");
  return {
    wake: async () => store.withOwner(async owner => {
      await owner.assertCurrent();
      // A durable next wake is written BEFORE advance. Eviction during advance
      // must not lose the next reconciliation. Scheduler callbacks may repeat.
      await schedule(clock.now() + intervalMs);
      const result = await advance(owner);
      await owner.assertCurrent();
      // The pre-advance callback may have fired and been consumed while busy.
      // Renew it from completion time so slow advances retain a future wake.
      await schedule(clock.now() + intervalMs);
      return result;
    }),
  };
}
