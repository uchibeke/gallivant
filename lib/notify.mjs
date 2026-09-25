// Notifications through ntfy: two transition messages and a throttled error class. Nothing else, ever.
// Bodies never carry diff or comment text; the PR URL is the only link.
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs.mjs";
import { hours } from "./time.mjs";

const ERROR_THROTTLE = hours(6);

import { shortRepo } from "./state.mjs";

/** Message shapes, kept as data so tests and docs can read them. */
export const messages = {
  ready: ({ entry, max, checks, reviewerNote }) => ({
    title: `${shortRepo(entry.repo)}#${entry.pr} ready for a human`,
    body: `Round ${entry.iteration}/${max}. Reviewer: ${reviewerNote}. Checks green (${checks}).`,
    priority: "default", tags: "white_check_mark", click: entry.url,
  }),
  needs: ({ entry, max, handle }) => ({
    title: `${shortRepo(entry.repo)}#${entry.pr ?? "?"} needs you: ${entry.reason}`,
    body: `Stopped in round ${entry.iteration}/${max}. gallivant why ${handle}`,
    priority: "high", tags: "warning", click: entry.url,
  }),
  error: ({ cls, fix }) => ({ title: `gallivant: ${cls}`, body: fix, priority: "high", tags: "rotating_light" }),
};

export function makeNotifier({ config, fetch = globalThis.fetch, clock = Date, log }) {
  const throttleFile = join(config.home, "notify-throttle.json");
  const target = config.notify?.ntfy || null;

  async function send(msg) {
    if (!target) { log?.info(`notify (no target): ${msg.title}`); return false; }
    const headers = { Title: msg.title, Priority: msg.priority, Tags: msg.tags };
    if (msg.click) headers.Click = msg.click;
    if (config.notify.email) headers.Email = config.notify.email;
    try {
      const res = await fetch(target, { method: "POST", headers, body: msg.body });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
      return true;
    } catch (e) {
      log?.error(`notify failed: ${e.message} (${msg.title})`);
      return false;
    }
  }

  return {
    ready: ctx => send(messages.ready(ctx)),
    needs: ctx => send(messages.needs(ctx)),
    /** At most one message per error class per six hours. Always logged. */
    async error(cls, fix) {
      log?.error(`${cls}: ${fix}`);
      const t = readJson(throttleFile, {});
      if (t[cls] && clock.now() - t[cls] < ERROR_THROTTLE) return false;
      writeJsonAtomic(throttleFile, { ...t, [cls]: clock.now() });
      return send(messages.error({ cls, fix }));
    },
    test: () => send({ title: "gallivant: test", body: "Notifications work.", priority: "low", tags: "wave" }),
  };
}
