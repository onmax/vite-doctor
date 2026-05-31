<div align="center">
  <h1>
    <img src="docs/public/doctor-icon.png" alt="" width="42" height="42" align="absmiddle">
    Doctor
  </h1>
  <p><strong>Catch the AI slop your agents ship.</strong></p>
  <p><code>pnpm dlx vite-doctor .</code></p>
  <p><a href="https://vite-doctor.onmax.me">Docs</a></p>
</div>

## Usage

```bash
pnpm dlx vite-doctor .
```

`vite-doctor` loads Doctor extensions and their rule packs, then composes `recommended` presets with `--extends auto` by default. Use `--extends vite/recommended,vue/recommended` for exact preset composition, and `--rules` for a final rule-id filter.

For Nuxt projects, `vite-doctor/nuxt` is the Nuxt module export path from the `vite-doctor` package:

```bash
pnpm add -D vite-doctor
pnpm nuxt doctor
```

Use `--framework vue|nuxt|vite|nitro` only when auto-detection needs an explicit override.

## Configuration

Standalone trusted config files can use the full Doctor config shape:

```ts
// doctor.config.ts
import { defineDoctorConfig } from "@vue-doctor/core";

export default defineDoctorConfig({
  rules: {
    "vite/define/no-secret-define": "error",
  },
});
```

Plugin surfaces accept the same policy through host config:

```ts
// vite.config.ts
import { doctor } from "vite-doctor";

export default {
  plugins: [
    doctor({
      config: {
        rules: {
          "vite/define/no-secret-define": "error",
        },
      },
    }),
  ],
};
```

For Nitro-backed Vite apps, including Vue, React, or any other Vite frontend, use the same plugin and let Doctor detect Nitro from project signals:

```ts
// vite.config.ts
import { doctor } from "vite-doctor";

export default {
  plugins: [doctor()],
};
```

Set `framework: "nitro"` only when auto-detection needs an explicit override.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: [
    [
      "vite-doctor/nuxt",
      {
        config: {
          rules: {
            "nuxt/routing/prefer-nuxt-useroute": "error",
          },
        },
      },
    ],
  ],
});
```

## Development

```bash
vp run ready
vp run -r test
vp run -r build
```
