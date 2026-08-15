import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor configuration (task M04, docs/02 §20, docs/07 Milestone 13).
 *
 * ## What this file is, and what it is not
 *
 * CLAUDE.md: "Do not create a separate mobile app during MVP. Add Capacitor
 * after the web implementation is stable." Milestone 13 is that point, and this
 * is the whole of it: Capacitor wraps *this* web build — the same React, the
 * same Worker, the same engine, the same Pixi — in a native shell. There is no
 * second application, no mobile-only code path, and docs/02 §20 forbids one
 * ("do not change authoritative ecology by device class").
 *
 * The native projects themselves (`ios/`, `android/`) are deliberately NOT in
 * the repository. `npx cap add ios` needs Xcode and `npx cap add android` needs
 * the Android SDK; generating them on a machine that has neither produces
 * scaffolding nobody has built or run, which is worse than an honest gap. See
 * `docs/06` and the Milestone 13 ADR for the exact procedure and for what is
 * still unverified because it needs real hardware.
 *
 * ## Why `webDir` is the Vite output
 *
 * Capacitor copies a *built* web directory into the native container; it never
 * runs Vite. So the mobile build is `pnpm build` followed by `npx cap sync`,
 * and anything that breaks the web build breaks the mobile one identically —
 * which is the point of wrapping rather than porting.
 *
 * One thing must be right for the wrapped build and is easy to get wrong: the
 * bundle is served from a custom scheme at the container root, so it must be
 * built with `EON_BASE_PATH` unset (or "/"), never with the GitHub Pages
 * project path.
 */
const config: CapacitorConfig = {
  appId: "dev.eon.sandbox",
  appName: "EON",
  webDir: "apps/web/dist",
  // Portrait and landscape both make sense for a world you pan around, and the
  // layout already handles narrow viewports (docs/06 §16).
  android: {
    // Mixed content is off by default; nothing here loads http:// resources.
    allowMixedContent: false,
  },
  ios: {
    // The simulation canvas is the page; bouncing it looks broken.
    scrollEnabled: false,
  },
  server: {
    // A production wrapper serves the copied bundle, never a dev server. A
    // `url` here would silently ship a build that only works on one network.
    androidScheme: "https",
  },
};

export default config;
