// Synthetic observations, consumed by the actual health routes and captures.
import { join } from "node:path";
import { writeJsonAtomic } from "../../lib/fs.mjs";
import { processIdentity } from "../../lib/daemon.mjs";
import { NOW } from "./fixture.mjs";

export const HEALTH_SECRET = "private-observation-credential-do-not-render";
export function seedHealth({ ctx, home }, state = "stale") {
  const now = Date.parse(NOW);
  ctx.config.harness = { codex: { bin: `/private/${HEALTH_SECRET}/codex` }, "openai-agents": { account: HEALTH_SECRET }, "codex-cloud": { bin: `/private/${HEALTH_SECRET}/codex` } };
  writeJsonAtomic(join(home, "daemon.json"), { pid: state === "down" ? 2147483646 : process.pid,
    identity: processIdentity(process.pid), startedAt: NOW, lastTick: state === "stale" ? new Date(now - 900_000).toISOString() : NOW,
    nextTick: new Date(now + 10_000).toISOString(), ...(state === "busy" ? { purpose: "runtime" } : {}),
    lastError: HEALTH_SECRET, login: HEALTH_SECRET });
  writeJsonAtomic(join(home, "provider-health.json"), { version: 1, scopes: {
    '["codex","operator"]': { ok: true, scope: "local-sign-in", apiConnectivity: "unchecked", observedAt: now - 310_000, nextAttemptAt: now - 10_000, detail: HEALTH_SECRET, fix: HEALTH_SECRET },
    [JSON.stringify(["openai-agents", HEALTH_SECRET])]: { ok: false, code: "AGENTS_QUOTA", observedAt: now - 20_000, nextAttemptAt: now + 40_000, detail: HEALTH_SECRET, fix: HEALTH_SECRET },
    '["codex-cloud","operator"]': { ok: true, observedAt: now - 20_000, nextAttemptAt: now + 40_000, detail: HEALTH_SECRET },
  } });
}
