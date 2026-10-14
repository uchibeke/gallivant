import { upInBackground } from "./up.mjs";
import { trackerInBackground, trackerForeground, trackerPort, trackerUrl, openTracker } from "../tracker_process.mjs";

// One startup path for start (with or without a PRD) and serve. A UI failure
// never resubmits a run or stops work already accepted by the daemon.
export async function startServices(ctx, options = {}, deps = {}) {
  const port = trackerPort(options.port);
  const { daemon = upInBackground, tracker = trackerInBackground, foreground = trackerForeground, open = openTracker } = deps;
  const messages = [], errors = [];
  if (!options.noDaemon) {
    try { const d = await daemon(ctx); messages.push(d ? `Daemon running (pid ${d.pid}).` : "Daemon already running."); }
    catch (error) { errors.push(`Daemon: ${error.message}. Retry with gallivant start; do not resubmit the PRD.`); }
  } else messages.push("Daemon startup skipped; existing daemons are unchanged.");
  if (!options.noServer) {
    try {
      await (options.foreground ? foreground : tracker)(ctx, { port });
      messages.push(`Dashboard: ${trackerUrl(port)}${options.foreground ? " (Ctrl-C stops this tracker)" : " (background)"}`);
      if (!options.noOpen && !await open(port)) messages.push("Browser could not be opened; use the dashboard URL above.");
    } catch (error) { errors.push(`Dashboard: ${error.message}. Retry gallivant serve --port ${port}; existing runs are unchanged.`); }
  }
  return { messages, errors };
}
