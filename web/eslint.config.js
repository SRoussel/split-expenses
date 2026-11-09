// Lint rules for the app, the Worker and the tests. Run with `npm run lint`; formatting is Prettier's.
// Recommended sets only: real mistakes and React hook misuse, not style.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-desktop/", "src-tauri/", ".wrangler/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "desktop/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["worker/**/*.ts", "shared/**/*.ts"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ["tests/**/*.mjs", "scripts/**/*.mjs", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // `_name` marks something unused on purpose.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Formatting is Prettier's job (npm run format); turn off any lint rule that would fight it.
  prettier,
);
