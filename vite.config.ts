import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["**/dist/**", "**/.vue-doctor/**"] },
  lint: {
    ignorePatterns: ["**/dist/**", "**/.vue-doctor/**"],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
