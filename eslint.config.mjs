// Flat ESLint config. Pragmatic by design: this repo predates linting, so the
// high-volume style/debt rules (explicit `any`, unused vars, empty catches, and
// a handful of minor correctness-adjacent rules) are WARNINGS — they surface in
// editors and `npm run lint` without failing CI on existing debt — while the
// hard-error protection is kept for genuine bugs (React hooks order, etc.).
// Tighten the warns to errors over time as the debt is paid down.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.bivy/**",
      "packages/ui/old/**",
      "test-results/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Redundant with the TypeScript compiler, which already flags undefined
      // names and knows the DOM/Node lib globals (setTimeout, fetch, …).
      "no-undef": "off",
      // Existing debt — keep visible but non-blocking.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-console": "off",
      // Minor correctness-adjacent findings — warn for now (some are false
      // positives, e.g. NUL bytes in terminal/ANSI parsing regexes).
      "no-useless-assignment": "warn",
      "no-control-regex": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "preserve-caught-error": "off",
    },
  },
  {
    // React view layer — keep hooks rules on (order is a real-bug class);
    // exhaustive-deps stays a warning.
    files: ["packages/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Config and plain-JS scripts run in Node without TS type information.
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
