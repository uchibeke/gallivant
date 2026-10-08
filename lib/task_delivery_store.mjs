// Durable single-host adapter. Its root MUST live on the durable coordinator volume.
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { acquireProcessLock } from "./daemon.mjs";
import { deliveryError } from "./task_delivery_contract.mjs";
export const MAX_DELIVERY_OPERATIONS = 256;
export const MAX_DELIVERY_STORE_BYTES = 32 * 1024 * 1024;
export const MAX_CANCELLATION_STORE_BYTES = 1024 * 1024;
const bytes = value => Buffer.byteLength(JSON.stringify(value, null, 2) + "\n");
const checkSize = data => {
  const { cancellations, ...ordinary } = data;
  if (bytes(ordinary) > MAX_DELIVERY_STORE_BYTES || (cancellations && bytes({ cancellations }) > MAX_CANCELLATION_STORE_BYTES)) throw receiptCapacityError();
};
export const receiptCapacityError = () => deliveryError("DELIVERY_CAPACITY", "Delivery receipt capacity reached; retain this namespace for retries, drain active work and archive it before provisioning a separate namespace for new operations. Never resend an old operation ID in a new namespace.");
export const scopeKey = scope => {
  for (const key of ["tenant", "account", "environment", "region"]) if (typeof scope?.[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(scope[key])) throw deliveryError("DELIVERY_SCOPE", `APort must supply validated ${key}`);
  return createHash("sha256").update(JSON.stringify([scope.tenant, scope.account, scope.environment, scope.region])).digest("hex");
};
export function createDeliveryStore(root) {
  const folder = scope => ensureDir(join(root, scopeKey(scope)));
  const read = scope => {
    const file = join(folder(scope), "delivery.json");
    try { if (statSync(file).size > MAX_DELIVERY_STORE_BYTES + MAX_CANCELLATION_STORE_BYTES) throw receiptCapacityError(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const data = readJson(file, { version: 1, tasks: {}, operations: {} });
    if (data.version !== 1) throw deliveryError("DELIVERY_VERSION", "Back up the delivery store and restore a compatible version before reopening tasks");
    checkSize(data);
    return data;
  };
  return {
    read,
    transaction: async (scope, fn) => {
      const dir = folder(scope), lock = acquireProcessLock(join(dir, "delivery.lock"), "task delivery");
      try { return await fn(read(scope), data => {
        checkSize(data);
        return writeJsonAtomic(join(dir, "delivery.json"), data);
      }); }
      finally { lock.release(); }
    },
  };
}
