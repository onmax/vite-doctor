# Vite Doctor

Framework-aware diagnostics for Vite, Vue, Nuxt, and Nitro projects.

Docs: [vite-doctor.onmax.me](https://vite-doctor.onmax.me)

## Alpha

The first npm alpha publishes `vite-doctor` only. Use `vite-doctor` as the single smart command for Vite, Vue, Nuxt, and Nitro projects; it detects the project type and enables the relevant built-in rule packs automatically.

## Usage

```bash
pnpm dlx vite-doctor@alpha .
```

`vite-doctor` loads the Vite, Vue, and Nuxt rule packs, then filters rules by detected framework, Nuxt modules and packages, rule requirements, optional type analysis, presets, and explicit `--rules`.

For Nuxt projects, `vite-doctor/nuxt` is the Nuxt module export path from the `vite-doctor` package:

```bash
pnpm dlx nuxt module add vite-doctor/nuxt
pnpm exec nuxt doctor
```

Use `--framework vue|nuxt|vite|nitro` only when auto-detection needs an explicit override.

## Development

```bash
vp run ready
vp run -r test
vp run -r build
```

## Release

The manual alpha release flow is documented in [RELEASE.md](./RELEASE.md).
