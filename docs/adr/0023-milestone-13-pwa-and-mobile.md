# ADR 0023 — Milestone 13: installable shell, lifecycle and the Capacitor boundary

Status: accepted · Date: 2026-08-15 · Engine 0.7.0 unchanged · Protocol 8 unchanged · Tasks M01–M07

Milestone 13 makes EON installable, usable with no network, well-behaved when a phone takes the page
away, and ready to be wrapped by Capacitor. It is entirely presentation and hosting: `ENGINE_VERSION`
stays **0.7.0**, `PROTOCOL_VERSION` stays **8**, and every golden hash is unchanged.

docs/02 §20 is the rule this milestone is written against — _do not change authoritative ecology by
device class_. There is no mobile code path, no reduced tick rate, no device-dependent constant. A
phone runs the same engine as a desktop, more slowly.

## 1. The offline shell (M01)

An installed EON has nothing to fetch. There is no API and no server state: the world is generated
from a seed, the simulation runs in a Worker, and saves live in IndexedDB. Once the bundle is on the
device, the network is only ever the thing that delivered it. So "works offline" is not a feature
here so much as the removal of an accidental dependency.

**The service worker is hand-written, 120 lines, in `apps/web/public/sw.js`.** A precache-manifest
plugin is the right tool for an app with a server; here it would buy nothing over the strategy below
and cost a build-time dependency that has to be kept in step with the Worker chunking — which is
exactly the piece most likely to break silently.

The strategy:

- **Navigations: network first, cached shell as fallback.** Someone online always gets the current
  build; someone offline still gets the app. The opposite order would serve yesterday's build to a
  user who reloaded specifically to get today's.
- **Same-origin GETs inside scope: cache first.** Vite emits content-hashed filenames, so a cached
  asset URL is _immutable_ — cache-first is correct rather than merely convenient, and it is what
  makes the simulation Worker and the Pixi chunks available offline.
- **Everything else: untouched.** Cross-origin and non-GET requests never reach a decision.

**Only the shell is precached on install.** Precaching a guessed asset list would fail the entire
install if one guess were wrong, and a failed install is a worse outcome than a second visit being
the one that completes the offline copy.

### 1a. Cache generation rides on the script URL

A browser refetches a service worker when its URL or its bytes change. `sw.js` is copied verbatim
from `public/`, so its bytes are **identical between two builds of different application code** — a
user would keep the old worker, and its cache, indefinitely. The registration appends the build
version (`sw.js?v=<sha>`), and the worker reads the same value back out of its own
`location.search` to name and expire its cache. One string, `APP_VERSION`, now lives in its own
module because two things need it and must agree: this, and the build id recorded in every world
manifest since Milestone 10.

### 1b. Everything is relative

`start_url`, `scope` and every icon path in the manifest are relative, as are the `<link>` hrefs in
`index.html`. The same bundle is served from `/` locally and `/EvoSim/` on a project Pages site, and
an absolute path is silent at build time and a 404 at run time — the same failure `vite.config.ts`
takes its `base` from the environment to avoid.

## 2. Icons are generated, not committed as opaque binaries (M01)

An installable app needs raster icons: Chromium wants 192 and 512 px PNGs, Android wants a maskable
one with safe padding, and iOS ignores SVG for the home screen entirely.

Committing binaries into a repository whose premise is that every number is reproducible is the wrong
shape — nobody can review a PNG diff, and nobody can tell whether it still matches the favicon in
`index.html`. So `pnpm icons` renders them from the same shape description as the favicon, through a
PNG encoder written out longhand (`node:zlib` supplies the only compression). Running it twice
produces byte-identical files.

Two details that are easy to get wrong and were not:

- **Maskable icons may be cropped to any shape.** Android's safe zone is the centre 80%, so the mark
  is inset 12.5% per side and the backdrop fills the frame, so no crop can expose a corner.
- **iOS composites the home-screen icon on black.** A transparent corner becomes a black notch
  _outside_ Apple's own rounded mask, so the 180 px icon is rendered opaque.

## 3. Lifecycle: pause when hidden, resume when shown (M03)

A backgrounded tab keeps its Worker alive. On a desktop that is mostly harmless; on a phone it is a
battery drain the user cannot see, and the OS may suspend and resume the process at arbitrary
moments. So the app decides what "away" means rather than discovering it.

**This changes scheduling, never state.** Pausing is exactly the pause button, and the pause button
changes when ticks run, never what a tick does (docs/02 §7). A world hidden for an hour and a world
watched for an hour reach the same state at the same tick, which is why this milestone cannot move a
hash even in principle.

Three rules, each with a test:

1. **Only a pause the app caused may be undone.** A world the user had already paused stays paused
   when the tab comes back. Anything else would start a simulation the user deliberately stopped.
2. **Resume restores the speed the user chose**, not a default — someone who left a world at 20×
   should find it at 20×.
3. **`pagehide` pauses and saves.** It is the last event a mobile browser reliably delivers before it
   may discard the page.

The save on the way out is **best effort by construction**: IndexedDB writes are asynchronous and the
page may be gone before one lands. That is acceptable because the cost is the few seconds since the
last autosave, and because blocking teardown is not something a web page can do. It also saves
**only a world that is already bound to a stored world** — hiding a tab must not silently create a
saved world the user never asked for.

## 4. Mobile polish (M02)

Most of this landed with Milestone 7 and was reviewed in ADR 0012: bottom sheets, the one-sheet rule,
44 px touch targets on coarse pointers, safe-area insets on the top bar and the inspector. Milestone
12 added them to the performance HUD and, after the browser suite found it, to the History panel.

What was still missing was mobile _behaviour_ rather than mobile _layout_:

- **`overscroll-behavior: none`.** Pull-to-refresh and rubber-band scrolling fire when a pan gesture
  reaches the edge of a sheet. On a phone that turns "drag the world" into "reload the page", which
  discards the running world.
- **Landscape safe areas.** A notch sits down one _side_ in landscape, not at the top; without
  `env(safe-area-inset-left/right)` the first top-bar control lands under it.
- **No tap highlight, no text selection on chrome.** Android paints a grey flash over anything
  tapped, including the canvas, and a drag starting on a label began selecting text instead of
  panning. Inputs opt back in — a world name you cannot select is a worse bug than a flash.

## 5. Storage that a phone will actually keep (M07)

Milestone 10 made saves durable against failure: checksums, all-or-nothing writes, quota errors
phrased for a human. What it could not address is that IndexedDB is **evictable by default**, and
mobile browsers are aggressive about it — Safari discards script-writable storage for origins the
user has not visited in about a week. A user who saves a world, closes the tab and returns next month
can find it gone, with nothing having failed and nothing having warned them.

`navigator.storage.persist()` is the standard's answer, and the app now asks — **once, after the
first successful save**. Asking on load would spend a permission prompt on a user who has not chosen
to keep anything; asking on every save would re-ask forever in browsers that say no.

The answer is genuinely three-valued and the UI says which one it got:

| State         | What the panel says                                                    |
| ------------- | ---------------------------------------------------------------------- |
| `persisted`   | Saved worlds are exempt from automatic eviction.                       |
| `evictable`   | The browser may reclaim saved worlds under pressure or a long absence. |
| `unsupported` | This browser does not say whether saved worlds can be evicted.         |

"No API" is not the same as "declined", and the app must not report the first as the second. A
thrown API is reported as `evictable`, because to the user that means the same thing as a refusal.

## 6. The Capacitor boundary, and what is honestly unverified (M04–M06)

CLAUDE.md: _"Do not create a separate mobile app during MVP. Add Capacitor after the web
implementation is stable."_ Milestone 13 is that point, and `capacitor.config.ts` is the whole of it.
Capacitor wraps _this_ web build — same React, same Worker, same engine, same Pixi. There is no
second application and docs/02 §20 forbids one.

**The native projects are deliberately not in the repository.** `npx cap add ios` needs Xcode and
`npx cap add android` needs the Android SDK; generating them on a machine that has neither produces
scaffolding nobody has built or run, which is worse than an honest gap. The procedure is:

```bash
pnpm build                 # EON_BASE_PATH unset: the wrapper serves from the container root
npx cap add ios            # macOS + Xcode
npx cap add android        # Android SDK
npx cap sync
npx cap run ios            # or: npx cap run android
```

One thing must be right for the wrapped build and is easy to get wrong: the bundle is served from a
custom scheme at the container **root**, so it must be built with `EON_BASE_PATH` unset — never with
the GitHub Pages project path.

**M05 and M06 — real iOS and Android device tests — are not done, and this ADR does not claim they
are.** They require hardware and native toolchains that the delivery environment does not have. What
_has_ been verified is everything that stands between here and them:

- the app runs in **WebKit** — the engine iOS actually uses — across all ten docs/07 PART E flows;
- it runs on a **phone-sized viewport with touch**, including pan, zoom and the one-sheet rule;
- the manifest, the icons and the worker are served correctly at a repository-path base;
- the shell **opens with the network switched off**, verified by reloading an offline context;
- lifecycle pause/resume works through a real `visibilitychange`.

The remaining risk those tests would retire is native-shell-specific: WKWebView's storage behaviour
under an app wrapper, memory pressure on a real device, and Android's WebView version spread. Those
are named in `TASKS.md` as the open tasks they are.

## 7. What the browser suite says

Four new scenarios, on every installed browser: manifest completeness (with every icon fetched, since
a manifest that lists a 404 installs with a blank icon and nothing warns), the worker served at the
deployment base, a worker that takes control, an offline reload, and lifecycle pause/resume.

One skip, documented in place: Playwright's WebKit build fails `page.reload()` with an internal error
once the context is offline — the navigation never completes, before any application code runs. The
two halves of that scenario WebKit _can_ answer are covered by the other tests. Skipping is honest;
pretending would be worse than the gap.
