// Durable single-host adapter. Its root MUST live on the durable coordinator volume.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { acquireProcessLock } from "./daemon.mjs";
import { deliveryError } from "./task_delivery_contract.mjs";
export const scopeKey = scope => {
  for (const key of ["tenant", "account", "environment", "region"]) if (typeof scope?.[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(scope[key])) throw deliveryError("DELIVERY_SCOPE", `APort must supply validated ${key}`);
  return createHash("sha256").update(JSON.stringify([scope.tenant, scope.account, scope.environment, scope.region])).digest("hex");
};
export function createDeliveryStore(root) {
  const folder = scope => ensureDir(join(root, scopeKey(scope)));
  const read = scope => {
    const data = readJson(join(folder(scope), "delivery.json"), { version: 1, tasks: {}, operations: {} });
    if (data.version !== 1) throw deliveryError("DELIVERY_VERSION", "Back up the delivery store and restore a compatible version before reopening tasks");
    return data;
  };
  return {
    read,
    transaction: async (scope, fn) => {
      const dir = folder(scope), lock = acquireProcessLock(join(dir, "delivery.lock"), "task delivery");
      try { return await fn(read(scope), data => writeJsonAtomic(join(dir, "delivery.json"), data)); }
      finally { lock.release(); }
    },
  };
}
