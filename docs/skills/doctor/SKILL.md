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

1. Use `vite-doctor . --changed --format agent` for uncommitted work. Use `vite-doctor . --since <base-ref> --format agent` for a committed branch or pull request. Run Doctor without either scope flag when Git is unavailable or the user asks for a project audit.
2. Read `status`, `scope`, and every Diagnostic's code, message, remediation, confidence, relative location, evidence, and optional edit plan.
3. Work only on Diagnostics owned by the requested change. Do not widen the task to unrelated findings.
4. Apply the smallest fix that satisfies the remediation and preserves project conventions. Treat structured edit plans as proposed edits, not permission to skip review.
5. Substitute the Diagnostic's Rule ID into `commands.verify` and run it after editing.
6. Run `commands.rerun` before finishing. Report remaining Diagnostics or incomplete evidence exactly.
7. Use the Diagnostic Reference URL when the inline remediation is ambiguous or framework behavior needs confirmation. Routine fixes should not require network access.

## Rules

- Use `vite-doctor` for Vite, Vue, Nitro, and Nuxt projects; do not invent framework-specific packages or binaries.
- Treat Rule IDs as execution/filtering selectors.
- Treat Diagnostic Codes as the stable remediation identity for docs, fixes, and user-facing explanations.
- Prefer `--format agent` for remediation work. Use JSON for full run metadata and SARIF for code-scanning integrations.
- An explicit `--format` is deterministic. Do not depend on automatic runtime recognition in scripts.
- Use Doctor terms consistently: Doctor, Rule, Rule Pack, Diagnostic Code, and Diagnostic.
- Keep code edits scoped to reported Diagnostics unless the user asks for broader cleanup.
