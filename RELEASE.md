# Release

The first public alpha publishes only `vite-doctor`. The standalone `vue-doctor`, `nuxt-doctor`, and `@vue-doctor/core` packages are workspace internals for this release path.

`vite-doctor` is the public entry point. It auto-detects Vite, Vue, Nuxt, and Nitro projects, loads the built-in rule packs, and filters rules by project framework, detected Nuxt modules/packages, rule requirements, optional type analysis, presets, and explicit `--rules`.

## Manual alpha

Prerequisites:

- npm access to `vite-doctor`
- npm 2FA or automation token configured for publish
- a clean release branch with the intended changes

Run the release locally:

```bash
pnpm install
pnpm release:check
pnpm release:version
pnpm release:pack
```

Inspect the tarball in `artifacts/`. Confirm that `packages/vite/package.json` is versioned as `0.0.1-alpha.1` and that the package contains `dist`.

Publish the alpha:

```bash
pnpm release:publish:alpha
```

Local publishing does not use npm provenance because provenance generation requires a supported CI provider. Use the manual GitHub Actions workflow when publishing with provenance is required.

Verify npm after publishing:

```bash
npm view vite-doctor@alpha version
npm view vite-doctor dist-tags --json
```

The `alpha` dist-tag should point at `0.0.1-alpha.1`. Do not move `latest` for this release.

## GitHub Actions

`.github/workflows/release.yml` is manual-only through `workflow_dispatch`. It is prepared for later CI/CD use, but the local manual release remains the default while GitHub Actions quota is constrained.

The workflow requires `NPM_TOKEN` and uses npm provenance through GitHub OIDC via `pnpm release:publish:alpha:provenance`.
