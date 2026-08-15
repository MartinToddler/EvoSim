// ESLint flat config for the EON workspace.
//
// Beyond the standard recommended rule sets, this config mechanically enforces
// the CLAUDE.md "engine purity" and determinism contract for packages/engine:
// no browser APIs, no React/Pixi imports, no Math.random / wall-clock access.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

const BROWSER_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "postMessage",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "location",
  "history",
  "performance",
];

// Timers and wall-clock scheduling must never influence authoritative simulation.
const TIMER_GLOBALS = ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "pnpm-lock.yaml"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.mjs",
            "apps/web/vite.config.ts",
            "playwright.config.ts",
            "capacitor.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Determinism guard for the pure simulation engine (CLAUDE.md hard rules).
    files: ["packages/engine/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", ...BROWSER_GLOBALS, ...TIMER_GLOBALS],
      "no-restricted-imports": [
        "error",
        {
          paths: ["react", "react-dom", "pixi.js"],
          patterns: ["react/*", "react-dom/*", "pixi.js/*", "@pixi/*"],
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Use the seeded project PRNG (Xoshiro128) instead of Math.random().",
        },
        {
          object: "Date",
          property: "now",
          message: "Wall-clock time must never influence authoritative simulation state.",
        },
        {
          object: "performance",
          property: "now",
          message: "Wall-clock time must never influence authoritative simulation state.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message: "Wall-clock time must never influence authoritative simulation state.",
        },
      ],
    },
  },
  {
    // The engine's package manifest exports only ".", but a relative deep import
    // ("../../packages/engine/src/internal") still resolves under Vite and tsc.
    // Close that hole: authoritative internals — above all the PRNG — must not
    // be reachable from the app, worker, renderer, UI or persistence code.
    files: ["apps/**/*.{ts,tsx}", "packages/!(engine)/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/engine/src/**", "@eon/engine/src/**", "@eon/engine/**"],
              message:
                "Import the engine's public API from '@eon/engine'. Reaching into its source " +
                "(especially internal.ts) would expose authoritative state such as the PRNG.",
            },
          ],
        },
      ],
    },
  },
  {
    // Protocol DTOs must stay presentation-free as well.
    files: ["packages/protocol/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["react", "react-dom", "pixi.js"],
          patterns: ["react/*", "react-dom/*", "pixi.js/*", "@pixi/*"],
        },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // The service worker is plain JS served verbatim from `public/`, so it is
    // outside every TS project and outside the bundler. Its globals are the
    // ServiceWorkerGlobalScope ones, which are neither Node's nor a page's.
    files: ["apps/web/public/sw.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    // Plain JS config files are not part of any TS project.
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
