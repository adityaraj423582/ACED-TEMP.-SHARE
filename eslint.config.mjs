import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.next/**",
      "**/next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx,mts,cts}"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Build/tooling scripts run in Node; give them the Node globals they use.
  {
    files: ["**/scripts/**/*.{js,cjs,mjs}", "**/*.config.{js,cjs,mjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        module: "writable",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        URL: "readonly",
        // Global since Node 18; used by the Electron binary installer.
        fetch: "readonly",
      },
    },
  },
  prettier,
);
