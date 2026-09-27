/**
 * ESLint flat config — enforces judging module isolation.
 *
 * Any file outside `src/judging/**`, `tests/**`, and `scripts/simulate*`
 * that imports from a path containing `judging/` will be flagged.
 */
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "drizzle.config.ts"],
  },
  // ── TypeScript parser for all .ts files ────────────────────────────
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Global: ban judging imports everywhere ─────────────────────────
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/judging/**"],
              message:
                "Judging module imports are restricted to src/judging/**, tests/**, and scripts/simulate*. " +
                "This isolation boundary protects competition-critical scoring logic from accidental coupling.",
            },
          ],
        },
      ],
    },
  },

  // ── Exempt allowed directories ─────────────────────────────────────
  {
    files: ["src/judging/**", "tests/**", "scripts/simulate*"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
