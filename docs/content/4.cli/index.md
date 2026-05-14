---
title: CLI
description: Run project checks and framework scans from one command.
---

Use `vite-doctor` from the project root. It can run existing project scripts or scan Vite, Vue, Nuxt, and Nitro code directly.

Install dependencies first. The CLI does not run package-manager install commands.

## Run project scripts

Run the checks already defined in `package.json`:

```bash
pnpm dlx vite-doctor@alpha
```

Preview what it will run:

```bash
pnpm dlx vite-doctor@alpha --dry-run
```

Doctor picks `ci`, then `ready`, then common scripts such as `check`, `lint`, `typecheck`, `test`, and `build`.

## Run a framework scan

```bash
pnpm dlx vite-doctor@alpha .
```

Useful options:

```bash
pnpm dlx vite-doctor@alpha . --changed
pnpm dlx vite-doctor@alpha . --max-warnings 0
pnpm dlx vite-doctor@alpha . --rules nuxt/fetch/no-raw-fetch-in-setup
pnpm dlx vite-doctor@alpha . --fix
```

## Run in CI/CD

This GitHub Actions example installs dependencies, then fails the build on any warning:

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
      - run: pnpm dlx vite-doctor@alpha . --max-warnings 0
```

## Nuxt projects

Nuxt projects should use the module and the CLI:

```bash
pnpm dlx nuxt module add vite-doctor/nuxt
pnpm exec nuxt doctor
pnpm dlx vite-doctor@alpha . --max-warnings 0
```
