<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/nuxt-doctor-wordmark.svg">
    <img src="docs/public/nuxt-doctor-wordmark.svg" alt="Nuxt Doctor" width="620">
  </picture>
</p>

<p align="center">
  <img src="docs/public/vue-doctor-wordmark.svg" alt="Vue Doctor" width="300">
  <img src="docs/public/nuxt-doctor-wordmark.svg" alt="Nuxt Doctor" width="300">
</p>

# Vite Doctor

Doctor-style tooling for modern Vite, Vue 3.5+, and Nuxt 4 codebases.

The workspace exposes Vite, Vue, and Nuxt entry points backed by one shared engine:

- `vite-doctor` for running a project's existing scripts with auto-detected tooling
- `vue-doctor` for Vue projects
- `nuxt-doctor` for Nuxt projects, including the `nuxt doctor` command when installed as a module

Vite Doctor provides the universal CLI runner, while Vue Doctor and Nuxt Doctor add framework-specific diagnostics. Nuxt Doctor extends Vue Doctor with Nuxt project detection, Nuxt manifest support, Nuxt-specific rules, a shared Nitro rule pack for `server/` and `app/server/` code, and a Nuxt module that can generate `.nuxt/doctor.manifest.json`.

## Usage

Run Doctor from a project root:

```bash
pnpm dlx vite-doctor
pnpm dlx vue-doctor
pnpm dlx nuxt module add nuxt-doctor
```

Run `pnpm dlx vite-doctor --dry-run` to preview the detected package manager and planned scripts. The CLI prefers `ci`, then `ready`, then available standard scripts: `check`, `lint`, `typecheck` or `type:check`, `test`, and `build`.

Install Nuxt Doctor in a Nuxt project when you want the module and `nuxt doctor` command:

```bash
pnpm dlx nuxt module add nuxt-doctor
pnpm exec nuxt doctor
```

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run a local workspace doctor scan:

```bash
vp exec nuxt-doctor .
```

Scans do not load repository-local `doctor.config.*` by default because those files can execute code. Only pass `--config` or `--trusted-config` when scanning a project you trust and intentionally want its executable config.

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo:

```bash
vp run -r build
```

- Run the development server:

```bash
vp run dev
```

## Packages

- `vite-doctor`: universal CLI runner that detects the package manager and runs existing project scripts.
- `@vue-doctor/core`: analyzer pipeline, public rule/plugin API, config loading, scoring, fixing, and text output.
- `vue-doctor`: Vue CLI with the built-in Vue rules.
- `nuxt-doctor`: Nuxt module, Nuxt command integration, manifest generator, built-in Nuxt rules, and the exported `nitroRulePack` consumed by Nuxt scans.

## Nuxt Module

Add the module to a Nuxt 4 app:

```ts
export default defineNuxtConfig({
  modules: ["nuxt-doctor/module"],
});
```

The module writes `.nuxt/doctor.manifest.json` during prepare/build lifecycle hooks, registers `nuxt doctor`, and exposes read-only MCP tools at `/mcp` so AI clients can request a structured Nuxt Doctor report from the running app. The CLI can scan without the manifest, but the manifest improves Nuxt auto-import, component, layer, and server-handler diagnostics.

The MCP tools are `doctor_report`, `doctor_rules`, and `doctor_explain_rule`. Pair the report with structured runtime logs, for example evlog wide events or local NDJSON drains, when you want an agent to connect static findings with production evidence.
