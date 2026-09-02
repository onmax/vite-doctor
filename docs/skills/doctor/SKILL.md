---
name: doctor
description: "Run Vite Doctor diagnostics for Vite, Vue, Nitro, and Nuxt projects and use stable diagnostic codes to guide fixes. Use before review on framework projects, when Doctor/Vite Doctor/Nuxt Doctor/diagnostics are requested, or when framework-specific runtime issues are suspected."
---

# Doctor

## Quick Start

Run Doctor from the target project root:

```bash
pnpm dlx vite-doctor . # or npx/bunx/yarn dlx
```

For Nuxt projects, the recommended workflow is:

```bash
pnpm add -D vite-doctor
```

```ts
export default defineNuxtConfig({
  modules: ["vite-doctor/nuxt"],
});
```

```bash
pnpm nuxt doctor
```

The standalone CLI also works for Nuxt one-off runs, CI fallback, or monorepo scans.

## Workflow

1. Run Doctor against the target project or package; install dependencies first if needed.
2. Read each Diagnostic Code, `why`, `fix`, docs URL, severity, confidence, and source location.
3. Open `https://vite-doctor.onmax.me/diagnostics/CODE` before recommending remediation.
4. Prefer the smallest fix that addresses the Diagnostic and preserves project conventions.
5. Run the narrowest relevant verification after editing.
6. Use `--format json` or `--format sarif` only when structured output is needed.

## Rules

- Use `vite-doctor` for Vite, Vue, Nitro, and Nuxt projects; do not invent framework-specific packages or binaries.
- Treat Rule IDs as execution/filtering selectors.
- Treat Diagnostic Codes as the stable remediation identity for docs, fixes, and user-facing explanations.
- Use Doctor terms consistently: Doctor, Rule, Rule Pack, Diagnostic Code, and Diagnostic.
- Keep code edits scoped to reported Diagnostics unless the user asks for broader cleanup.
