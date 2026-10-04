import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { acquireProcessLock } from "./daemon.mjs";
import { TASK_VERSION } from "./task_contract.mjs";

export const taskError = (code, message) => Object.assign(new Error(message), { code, version: TASK_VERSION });
export function taskRoot(home, id) {
  if (!/^task-[a-f0-9]{24}$/.test(id)) throw taskError("TASK_INPUT", "task ID must be task- followed by 24 lowercase hex characters");
  return join(home, "tasks", id);
}

export function taskStore(home) {
  const read = id => {
    const task = readJson(join(taskRoot(home, id), "intake.json"));
    if (!task) throw taskError("TASK_NOT_FOUND", `no intake ${id}`);
    if (task.version !== TASK_VERSION) throw taskError("TASK_VERSION", "unsupported task version; use a compatible package before reopening this intake");
    return task;
  };
  return {
    read,
    save: task => writeJsonAtomic(join(taskRoot(home, task.id), "intake.json"), task),
    list: () => {
      let names;
      try { names = readdirSync(join(home, "tasks")); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
      // A failed input check or crash before first save can leave an empty lock
      // namespace. It is not an intake and must not break all task discovery.
      return names.filter(n => /^task-[a-f0-9]{24}$/.test(n) && existsSync(join(home, "tasks", n, "intake.json"))).map(read);
    },
    locked: async (id, fn) => {
      const root = ensureDir(taskRoot(home, id));
      let lock;
      try { lock = acquireProcessLock(join(root, "intake.lock"), "task intake"); }
      catch (e) { throw taskError("TASK_BUSY", e.message); }
      try { return await fn(); } finally { lock.release(); }
    },
  };
}
