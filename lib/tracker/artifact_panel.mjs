import { button, loadingState } from "./primitives.mjs";

export const artifactPanel = () => `<dialog id="artifact-viewer" class="artifact-viewer" aria-labelledby="artifact-title">
<header class="artifact-toolbar">
<div class="artifact-title"><h2 id="artifact-title">File viewer</h2>${button("Close", { id: "artifact-close" })}</div>
<div class="artifact-actions">
<div role="group" aria-label="File view">${button("Preview", { id: "artifact-preview", "aria-pressed": "true" })}${button("Source", { id: "artifact-source", "aria-pressed": "false" })}</div>
${button("Copy source", { id: "artifact-copy-source", disabled: true })}${button("Copy link", { id: "artifact-copy-link" })}
</div>
<p id="artifact-feedback" class="note" role="status"></p>
</header>
<div class="artifact-scroll" id="artifact-scroll" tabindex="0" role="region" aria-label="File contents">
${loadingState("Loading saved file…", { id: "artifact-loading", "data-skeleton": "true", hidden: true })}
<div id="artifact-status" role="status"></div>
${button("Retry file", { id: "artifact-retry-file", hidden: true })}
<div id="artifact-meta" hidden></div>
<div id="artifact-body"></div>
</div>
</dialog>`;
