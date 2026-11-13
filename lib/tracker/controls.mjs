import { controlPending, MAX_NOTE, lastMessage } from "../control.mjs";
import { redact } from "../execution_io.mjs";
import { controlView } from "./control_view.mjs";
import { controlFeedback } from "./control_feedback.mjs";
import { esc, button, textarea } from "./primitives.mjs";

export function taskControls({ id, entry, run, initialLaunch, controlContext, controlInstance, controlToken, refreshHref }) {
  if (!controlToken && entry.state !== "done") return "";
  const view = controlContext || controlView(entry, run, {}, { initialLaunch });
  const available = view.controls, saved = lastMessage(entry), feedback = controlFeedback(entry.control, entry.reason);
  const result = `<div class="control-result"><p id="control-status" class="feedback-status" role="status" aria-live="polite" data-status="${feedback.state}" data-state="${feedback.tone}">${esc(redact(feedback.text))}</p><p id="control-times" class="note">${esc(feedback.times)}</p>
${button("Check request status", { id: "control-check" })} ${button("Retry same request", { id: "control-retry", hidden: true })}
<a id="control-refresh" href="${esc(refreshHref)}" hidden>View updated run</a></div>`;
  const attributes = `id="run-controls" class="run-controls" aria-labelledby="control-heading" data-entry="${esc(id)}" data-instance="${esc(controlInstance)}" data-token="${esc(controlToken || "")}" data-pending="${controlPending(entry.control)}" data-request-id="${esc(entry.control?.id || "")}"`;
  if (entry.state === "done") return `<section ${attributes} data-closed="true">
<h2 id="control-heading">Request status</h2><p class="note">This PR is closed or merged. Start a follow-up PRD for further changes.</p>
<p class="note control-target">Saved requests for <strong>${esc(id)}</strong> · read only</p>
${result}</section>`;
  const action = (name, label, help, extra = {}) => button(label, { "data-action": name, "data-available": String(available[name]),
    "aria-describedby": help, disabled: !available[name], ...extra });
  return `<section ${attributes}>
<h2 id="control-heading">Task actions</h2>
<p class="note control-target">Applies to <strong>${esc(id)}</strong> · current logical task</p>
<p id="control-gate" class="control-gate"${view.gate ? "" : " hidden"}>${esc(redact(view.gate))}</p>
<form id="message-form" class="message-composer">
<label for="run-note">Message agent</label>
<p id="message-help" class="note">${initialLaunch ? "Start the first run from the approved brief with your clarification after repairing launch prerequisites." : "Continues the same session with your correction when the action is available. Ordinary messages wait until current work ends."} Sending does not change the approved brief.</p>
${textarea("", { id: "run-note", rows: 4, maxlength: MAX_NOTE, required: true, "aria-describedby": "message-help draft-status", placeholder: "Share an update or give the agent direction…", disabled: !available.message })}
<div id="interrupt-option"${view.active ? "" : " hidden"}><label class="interrupt-option"><input id="interrupt-run" type="checkbox" aria-describedby="interrupt-help"${available.interrupt ? "" : " disabled"}><span>Interrupt current work to apply this message</span></label><p id="interrupt-help" class="note">Explicitly stops the current process at the next coordinator check, preserves unfinished files and resumes the same session. In-progress edits may need repair; a continuation uses your agent allowance.</p></div>
<div class="message-footer"><p id="draft-status" class="note">Drafts stay in this browser for this task. Discard clears the draft.</p><div class="composer-buttons">${button("Discard draft", { id: "discard-draft" })}${action("message", "Send message", "message-help", { type: "submit", disabled: true })}</div></div>
</form>
${result}
<details id="last-message"${saved ? "" : " hidden"}><summary>Last submitted message</summary><pre>${esc(redact(saved?.note || ""))}</pre>${button("Edit and resend", { id: "restore-message" })}</details>
<div class="recovery-controls"><h3>Recovery &amp; observation</h3><p class="note">The approved brief, existing gates and round counts still apply. These actions do not approve changes or reset authority.</p><div class="run-actions">
<div>${action("resume", "Resume agent", "resume-help")}<p id="resume-help" class="note">${esc(view.resume)}</p></div>
<div>${action("recheck", "Recheck PR", "recheck-help")}<p id="recheck-help" class="note">${esc(view.recheck)}</p></div>
</div></div>
<details class="cancel-controls"><summary>Stop this task</summary><p id="cancel-help" class="note">${esc(view.cancellation)}</p>${action("cancel", "Cancel task", "cancel-help")}</details>
</section>`;
}
