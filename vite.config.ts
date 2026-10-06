import { configDefaults, defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: { neverBundle: ["eslint-plugin-vue", "oxc-parser", "typescript"] },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["**/dist/**", "**/.vue-doctor/**"] },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/.vue-doctor/**",
      "docs/app/**",
      "docs/server/**",
      "docs/examples/**",
      "tests/fixtures/**",
    ],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
  test: {
    // Agent worktrees under .claude/ are full repo checkouts; collecting them duplicates and breaks the suite.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    setupFiles: ["./tests/setup.ts"],
  },
});
