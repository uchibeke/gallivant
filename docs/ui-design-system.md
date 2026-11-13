# Interface foundation

The shared server-rendered shell connects Overview, Tasks, Chains, System health,
Run history and New task. Tasks focuses the existing overview search; all views
retain the same task facts and root/mounted URL contract.

## Composition

- `lib/tracker/shell.mjs` owns the document, CSP, navigation, theme menu and URL
  builder. Pass the mount prefix and query context through every internal link.
- `lib/tracker/primitives.mjs` owns escaping, badges, buttons, fields, native
  select controls, navigation tabs, disclosure menus, notices, loading and empty
  states. Text and attributes are escaped; composition slots contain only HTML
  from trusted renderers. Icons come from one local 24px stroke vocabulary.
- `pages.mjs` composes existing read models. A visual label never certifies a
  completed task or turns missing evidence into success. Exit zero is an exit
  observation, not verification of delivery.
- `assets.mjs` composes the CSS and classic browser scripts into the existing
  `/tracker.css` and `/tracker.js` routes. There is no build-time runtime bundle,
  framework, CDN, font request or additional application state store.

## Tokens and states

`tokens.css` defines the public `--gv-*` host contract: canvas, surface, bench,
text, muted/subtle text, borders, hover, accent, focus, action/on-action and
success/warning/danger. Use semantic tokens; add no component-specific palette.
Dark is graphite with restrained cyan; light is warm neutral with darker cyan
and status colors for contrast. System fonts and 4/8/12/16/24/32px spacing keep
rendering portable. `--gv-font`, `--gv-mono`, `--gv-size`, `--gv-r`, `--gv-pad`
and `--gv-sidebar` remain supported override points.

`?theme=dark|light` forces the theme; absent or invalid values follow the system.
The appearance menu changes only that parameter, retaining historical selection,
filters and mount prefix. Low-specificity defaults allow host `:root` overrides
before or after the stylesheet. Same-origin hosts can inject their stylesheet
into the document. Cross-origin frames must pass `?theme=`; parent CSS does not
cross that boundary.

Use `:focus-visible`, native `disabled`, `aria-busy` for pending controls,
`aria-invalid` for invalid fields and `data-state=error|pending|success` for
request feedback. Status text accompanies color. Applied requests mean the
coordinator applied them, never that the agent or task finished. Empty and
connecting states contain explicit text; they do not resemble successful work.

## Interaction and layout

One banner, labelled navigation, a named task-list aside, one main landmark and
a first-focus skip link appear on each workspace page. Native buttons collapse
list groups. Native disclosure menus support Enter/Space; Escape closes and
returns focus to the summary. Outside clicks dismiss without stealing focus.
Navigation tabs are links, not ARIA tabs controlling hidden panels.

Controls have at least 44px targets. At narrow widths the shell stacks, overview
records reflow and long tables/logs scroll within named keyboard-focusable
regions. Text and paths wrap without widening the page. Reduced motion disables
nonessential animation and transitions. `shell.js` handles navigation and list
controls; `controls.js` owns request feedback and review polling; `tracker.js`
keeps bounded log rendering. `lifecycle.js` pauses scheduled reads when hidden
and cancels timers/active reads on page exit. A cached-page restoration restarts
each read loop in place, retaining the draft, focus, selection and scroll. Late
responses from the previous lifecycle cannot update the restored page. Pending
POSTs settle their original response without being resent. Log streams reconnect
using the last delivered event ID; `Last-Event-ID` on subsequent network retries
takes precedence over the initial `after` URL cursor. Finished logs stay intact.
Never reload over an unsent draft or persist control tokens.

## Browser verification

Requires Node 22+ and the exact dev dependencies in `npm-shrinkwrap.json`:

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium firefox webkit
npm run test:ui
```

On Linux add `--with-deps` to install supported system dependencies too.
The [final qualification guide](ui-qualification.md) describes the pinned Linux
image, Chromium references and three-engine semantic suite. macOS may require
permission to launch Chromium outside a restrictive process sandbox; do not
remove production protections to make a capture work.

`test/ui/fixture.mjs` is the single synthetic fixture, version 1: six task rows,
recorded finished attempts, a fixed clock at 2026-09-24 14:30 UTC, and no daemon.
Its real state/run files live in a disposable temporary directory. It calls the
actual serve handler and mount adapter at `/` and `/gallivant`; it never creates
a production context or reads credentials. Execution start/kill boundaries
throw. Protected POSTs only queue fixture state. Each test closes its browser,
server and temporary state, including on failure. Browser requests outside the
fixture origin are rejected. The tarball smoke test reuses this fixture with the
installed runtime and checks all page/API/asset routes.

The suite checks both themes/system/host overrides, the five contract widths,
landscape, 200% content zoom plus its equivalent reduced CSS viewport, keyboard
navigation, axe WCAG AA rules, malicious text, CSP and protected controls.
The existing transport tests additionally cover remote peers and port mismatch.
Browser checks complement those tests; automated accessibility is not a complete
manual accessibility audit. Firefox/WebKit journeys run in final qualification.
The runtime OS/Node matrix and release workflow remain separate and unchanged.

## Capture provenance

The approved before image is a real Chromium 145.0.7632.6 render of base
`5d846abb5c47db40ea36d822745614e8dfdd0505`, captured before source edits.
The foundation image uses the same fixture, fixed time, dark theme and
1440 × 1000 CSS-pixel viewport (full-page capture, device scale 1).
Both captures were visually inspected. Cross-OS font rasterization is not a
pixel-regression gate; CI qualifies geometry, semantics, keyboard and contrast.

```sh
node test/ui/capture.mjs foundation-overview-dark
```

The foundation approved `docs/ui/previews/before-overview-desktop.png` and
`docs/ui/previews/foundation-overview-dark.png`. See the
[overview guide](ui-overview.md) for its subsequent approved captures.
Do not regenerate the before image from redesigned source. Keep all other
screenshots/traces in a temporary directory or CI artifacts. Browser tools
and fixtures are excluded from the published package. Approved documentation
images ship with the guides so relative image links remain usable.

To roll back the foundation, revert its code/assets and dev-tooling commit;
there is no state migration or task-engine change to reverse.

## Shared navigation feedback

`links.mjs` supplies one safe outgoing-link contract for SSR and browser decoration.
`navigation.js` applies it to initial and dynamically inserted links, with a visible
new-tab hint. Internal navigation, downloads and modified clicks retain native
browser behavior. The shell delays navigation progress by 200ms, so fast page changes do not flash
a loading panel. Its sticky host has zero height and an absolutely positioned
panel, so showing it never moves the document, including inside a host frame. Loading
uses text plus static skeleton bars and respects reduced motion. Page restoration
clears pending feedback. It never retries a control or changes task authority.

## Shared request feedback

`feedback.js` supplies `trackerFeedback(status, { mirror, region })`. A controller
calls `show(text, { state, pending, detail, button, label })` to display a status,
optional feedback beside the triggering action, `aria-busy` and a working label.
It uses text nodes, semantic tokens and reduced-motion-safe indicators. It never
starts work, certifies completion, disables authority checks or retries a request.
Navigation, task preparation and coordinator controls share this helper.

Use a single live status for announcements; visual mirrors use `aria-live="off"`.
Keep confirmation separate from status. The preparation journey highlights the
saved phase, not an invented percentage. The header has one labelled New task
action; approval instructions belong in the preparation flow. Disclosure chevrons
use `disclosureIcon()` for a padded, non-shrinking slot and consistent rotation.
Other shared icons sit in controls with gaps and 44px touch targets.
