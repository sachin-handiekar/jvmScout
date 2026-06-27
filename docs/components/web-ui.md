# Component Review — Web UI (`ui/`)

Vanilla HTML/CSS/JS single-page app, no build step, served by the collector as
static files. GitHub-dark theme, hash-based router, five views (Dashboard,
Exceptions, Detail, Live Feed, JVM Info), WebSocket live feed with reconnect.
~590 LOC (`index.html`, `css/styles.css`, `js/app.js`).

## What's already strong

- **XSS-conscious.** A single `esc()` helper HTML-escapes interpolated values and
  is used consistently across tables, detail, frames, and the live feed
  (`js/app.js:7-12`).
- **Resilient live feed.** WebSocket auto-reconnects every 3 s, picks `wss` on
  HTTPS, caps memory at 500 events / DOM at 200, and shows a connection status
  dot (`js/app.js:274-292`).
- **Genuinely useful detail view.** Collapsible sections, expandable per-frame
  locals, and the BCI badge keyed on `source === "bci_shadow"`
  (`js/app.js:147-160`) — this is the product's "wow" surface.
- **Zero dependencies / no build** keeps it trivial to serve and audit.

## Production-readiness gaps

### P0 — Security / auth

1. **No authentication UI.** Pairs with the collector's missing auth — once the
   collector requires a token, the UI needs a login (or token entry) and must
   send credentials with `fetch`/WebSocket. Today anyone reaching the page sees
   all captured data.
2. **No Content-Security-Policy.** The app relies entirely on `esc()` for safety;
   one missed interpolation = stored XSS that runs in an authenticated session.
   Have the collector send a strict CSP header (and `X-Content-Type-Options`,
   `X-Frame-Options`) as defense-in-depth. Note the heavy use of inline
   `onclick="..."` handlers (`js/app.js:110,124,156`) means a strict CSP will
   require moving to `addEventListener` / event delegation first.

### P1 — UX / correctness

3. **Dashboard doesn't refresh.** `renderDashboard` fetches `/stats` once
   (`js/app.js:38-42`); the "live overview" is static until the user re-navigates.
   Add a polling interval (and pause when the tab is hidden).
4. **Inline-handler architecture is fragile.** Rendering is `innerHTML` string
   concatenation with inline handlers and a few `window.*` globals
   (`pageEx`, `js/app.js:129`). It works at this size but is error-prone to
   extend and blocks CSP. Move to event delegation; consider a tiny render
   helper. (A full framework is not warranted.)
5. **Accessibility.** Clickable table rows and frame headers use `onclick` with
   no keyboard focus/role (`js/app.js:110,156`); no ARIA, no focus states. Make
   rows real links or add `role="button"` + `tabindex` + key handlers.

### P2 — Polish (matters for a ProductHunt launch)

6. **Branding/first-run.** No logo, no favicon, no jvmScout wordmark, no empty
   "getting started / point an agent here" guidance when there's no data yet.
   The first impression on launch day is this screen — invest here.
7. **Timestamps shown raw.** UTC strings are printed verbatim
   (`js/app.js:117,182`); add relative time ("2m ago") and/or local-time
   formatting.
8. **Loading states are text-only** ("waiting for events…", "collector
   unreachable"). Lightweight skeletons/spinners read as more polished.
9. **No light theme / density options** — fine for v1, but a toggle is cheap
   goodwill.

### P3 — Engineering

- **No tests.** Even a couple of Playwright smoke tests (load dashboard, open a
  detail, see a live event) would catch regressions and double as the demo
  script.
- **No asset versioning/caching strategy** — fine while unbundled, but add cache
  headers from the collector so updates aren't stale.

## Suggested order

1. CSP + auth-aware fetch/WS (P0) — do the `onclick` → delegation refactor as the
   enabling step.
2. Dashboard auto-refresh + accessibility (P1).
3. Branding, empty states, relative timestamps (P2) — highest visual ROI for the
   launch.
4. Playwright smoke tests (P3).

## Checklist

- [ ] Auth-aware UI (login / token) sending creds on fetch + WS
- [ ] Strict CSP + security headers (requires `onclick` → event delegation)
- [ ] Dashboard auto-refresh (paused when hidden)
- [ ] Keyboard accessibility + ARIA on rows/frames
- [ ] jvmScout branding: logo, favicon, wordmark
- [ ] Empty/first-run "point an agent here" guidance
- [ ] Relative + local timestamps
- [ ] Loading skeletons
- [ ] Playwright smoke tests
