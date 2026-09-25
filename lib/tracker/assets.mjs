// The tracker's static files, read from templates/tracker/ once per start.
//
// They are files rather than strings in a module so that the CSS is CSS and the script is JavaScript: an editor
// highlights them, and the CSP can be `script-src 'self'` and `style-src 'self'` with no nonce and no hash to keep
// in step. Read once, because they cannot change under a running server and re-reading per request would be a file
// system call on every page load.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "tracker");

const load = name => readFileSync(join(DIR, name), "utf8");

/** Path to content type, for the two files the pages ask for. Anything else is not an asset and is a 404. */
export const ASSETS = Object.freeze({
  "/tracker.css": { body: load("tracker.css"), type: "text/css; charset=utf-8" },
  "/tracker.js": { body: load("tracker.js"), type: "text/javascript; charset=utf-8" },
});

/**
 * The palette a page should force, from `?theme=`.
 *
 * `prefers-color-scheme` inside an iframe follows the browser, not the page that framed it, so a dark parent gets a
 * light frame and it looks broken. A parent that knows its own theme passes it on the iframe src and this stamps it
 * on the root element, where the stylesheet's `[data-theme]` rules pick it up. Anything but dark or light is
 * ignored rather than rejected: a bad value should fall back to the system setting, not fail the page.
 */
export const themeOf = value => (value === "dark" || value === "light" ? value : null);
