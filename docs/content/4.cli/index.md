---
title: CLI
description: Run one CLI command for JavaScript, Vue, and Nuxt projects.
---

Use `vite-doctor` when you want one CLI command that detects a JavaScript project and runs the checks it already defines.

`vite-doctor` does not install dependencies. Install dependencies first, then run the CLI from the project root.

## Run the project checks

Run the default project plan:

```bash
pnpm dlx vite-doctor
```

Use the explicit command when you want it in scripts:

```bash
pnpm dlx vite-doctor run
```

Preview the detected package manager and scripts without running them:

```bash
pnpm dlx vite-doctor --dry-run
```

Expected output looks like this:

```text
Package manager: pnpm
Commands:
- pnpm run ready
```

## What the CLI detects

`vite-doctor` reads `package.json` and lockfiles from the current working directory.

It detects the package manager in this order:

1. `packageManager` in `package.json`
2. `pnpm-lock.yaml`
3. `bun.lock` or `bun.lockb`
4. `yarn.lock`
5. `package-lock.json` or `npm-shrinkwrap.json`
6. `npm` fallback

It selects scripts in this order:

1. `ci`, unless the script calls `vite-doctor`
2. `ready`
3. Available standard scripts: `check`, `lint`, `typecheck` or `type:check`, `test`, `build`

The CLI stops on the first failed command and exits with that command's exit code.

## Add a script contract

For monorepos, define one root script that runs the workspace checks in the right order:

```json
{
  "scripts": {
    "ready": "pnpm lint && pnpm test && pnpm build"
  }
}
```

If your project already has `ci`, `vite-doctor` runs that first. Use `ready` when you want one aggregate command that works locally and in automation.

## Use in automation

This GitHub Actions example uses pnpm. Keep the install step explicit so dependency setup remains visible in logs.

```yaml
name: Checks

on:
  pull_request:
  push:
    branches: [main]

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm dlx vite-doctor
```

## Run framework scans

Use `vite-doctor` for project command orchestration and framework-aware scans:

```bash
pnpm dlx vue-doctor
pnpm dlx vite-doctor . --max-warnings 0
```

Nuxt projects can also add the module and run `nuxt doctor`:

```bash
pnpm dlx nuxt module add vite-doctor/nuxt
pnpm exec nuxt doctor
```

## Troubleshooting

### No package.json found

Run `vite-doctor` from the project root, or change into the package directory before running it.

### No project scripts found

Add one of these scripts to `package.json`: `ci`, `ready`, `check`, `lint`, `typecheck`, `type:check`, `test`, or `build`.

### A dependency command is missing

Install dependencies before running `vite-doctor`. The CLI does not run package-manager install commands.
