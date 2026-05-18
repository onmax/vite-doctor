---
name: doctor
description: "Run Doctor diagnostics for Vue, Vite, Nitro, and Nuxt projects and use diagnostic codes to guide fixes. Use before review, when framework-specific issues are suspected, or when the user asks for Doctor, Vite Doctor, Vue Doctor, Nitro Doctor, Nuxt Doctor, or diagnostics."
---

# Doctor

## Quick Start

Run Doctor from the project root before review:

```bash
pnpm dlx vite-doctor@alpha .
```

Use package-manager equivalents when needed:

```bash
npx vite-doctor@alpha .
bunx vite-doctor@alpha .
yarn dlx vite-doctor@alpha .
```

For Nuxt projects, start with the same CLI command. Doctor will surface Nuxt-specific
warnings and setup guidance when the project needs it.

## Workflow

1. Run Doctor against the target project or package.
2. Read each diagnostic code, why, fix, docs URL, and source location.
3. Open the diagnostic docs at `/diagnostics/CODE` before recommending a remediation.
4. Prefer the smallest fix that addresses the diagnostic and preserves project conventions.
5. Use `--format json` only when structured machine output is needed for automation.

## Rules

- Agent Consumers run Doctor and consume Diagnostics.
- Use the CLI and structured diagnostic output as the integration path.
- Treat rule IDs as execution/filtering selectors.
- Treat diagnostic codes as the stable remediation identity.
- When editing code, keep fixes scoped to reported diagnostics unless the user asks for broader cleanup.
