# Catch the AI slop your agents ship.

<p>
  <img src="docs/public/doctor-icon.png" alt="Doctor" width="96" height="96">
</p>

Doctor scans Vite, Vue, Nuxt, and Nitro projects before review and flags framework bugs agents often miss.

Docs: [vite-doctor.onmax.me](https://vite-doctor.onmax.me)

## Usage

```bash
pnpm dlx vite-doctor@alpha .
```

`vite-doctor` loads the Vite, Vue, and Nuxt rule packs, then filters rules by detected framework, Nuxt modules and packages, rule requirements, optional type analysis, presets, and explicit `--rules`.

For Nuxt projects, `vite-doctor/nuxt` is the Nuxt module export path from the `vite-doctor` package:

```bash
pnpm dlx nuxt module add vite-doctor@alpha/nuxt
pnpm pkg set scripts.doctor="vite-doctor . --max-warnings 0"
pnpm doctor
```

Use `--framework vue|nuxt|vite|nitro` only when auto-detection needs an explicit override.

## Development

```bash
vp run ready
vp run -r test
vp run -r build
```
