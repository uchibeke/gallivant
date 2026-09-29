// The tracker's static files, read from templates/tracker/ once per start.
//
// They are files rather than strings in a module so that the CSS is CSS and the script is JavaScript: an editor
// highlights them, and the CSP can be `script-src 'self'` and `style-src 'self'` with no nonce and no hash to keep
// in step. Read once, because they cannot change under a running server and re-reading per request would be a file
// system call on every page load.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "..", "templates", "tracker");

const load = name => readFileSync(join(DIR, name), "utf8");

/**
 * lib/harness_log.mjs, as a classic script the served file can carry.
 *
 * The per-harness event reader lives beside the adapters, because that is where knowing a harness's stream shape
 * already lives. The browser needs the same reader, and a second copy of it in templates/ would drift: the reason
 * there is one is that the five log panels command-center replaced were five copies of one parse. So the module's
 * source is spliced in with its `export` keywords dropped, which is all that separates it from a script: it imports
 * nothing, by design, and a test asserts the spliced copy behaves as the imported one does.
 */
const inlined = () => readFileSync(join(HERE, "..", "harness_log.mjs"), "utf8").replace(/^export (const|function) /gm, "$1 ");

/** Path to content type, for the two files the pages ask for. Anything else is not an asset and is a 404. */
export const ASSETS = Object.freeze({
  "/tracker.css": { body: load("tracker.css"), type: "text/css; charset=utf-8" },
  // Strict mode is asserted here rather than inside either file: a "use strict" directive only counts as the first
  // statement of the script, and the spliced module goes in ahead of the script that used to carry it.
  "/tracker.js": { body: `"use strict";\n${inlined()}\n${load("tracker.js")}`, type: "text/javascript; charset=utf-8" },
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
