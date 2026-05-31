<p align="center">
  <img src="https://vite-doctor.onmax.me/og/doctor-lifeline-bg.png" alt="Vite Doctor" width="100%">
</p>

<h1 align="center"><img src="https://vite-doctor.onmax.me/doctor-icon.png" alt="" width="32" height="32" style="vertical-align: middle;"> Vite Doctor</h1>

<p align="center">Catch framework bugs AI agents miss. Diagnostics for Nuxt, Vue, Nitro and Vite.</p>

<p align="center">
  <code>pnpm dlx vite-doctor .</code>
</p>

<p align="center">
  <a href="https://vite-doctor.onmax.me">Docs</a>
</p>

## Usage

Run Vite Doctor from the project root:

```bash
pnpm dlx vite-doctor .
```

Vite Doctor reads app code, build config, project metadata, and server handlers to catch framework bugs before review. It picks the Nuxt, Vue, Nitro, or Vite diagnostics that fit your project.

Need a narrower Doctor Run? Select exact presets, one Rule, or a framework override:

```bash
pnpm dlx vite-doctor . --extends vite/recommended,vue/recommended
pnpm dlx vite-doctor . --rules nuxt/fetch/no-raw-fetch-in-setup
pnpm dlx vite-doctor . --framework nitro
```

For Nuxt projects, install Vite Doctor and run it through Nuxt:

```bash
pnpm add -D vite-doctor
pnpm nuxt doctor
```

Use `--framework` only when Doctor cannot identify the framework automatically.

## Configuration

Standalone trusted config files can use the full Doctor config shape:

```ts
// doctor.config.ts
import { defineDoctorConfig } from "vite-doctor/config";

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

In Vite config, the same plugin covers Vite, Vue, and Nitro projects. Doctor picks the matching diagnostics automatically:

```ts
// vite.config.ts
import { doctor } from "vite-doctor";

export default {
  plugins: [doctor()],
};
```

Set `framework: "nitro"` only when Doctor cannot identify the framework automatically:

```ts
// vite.config.ts
import { doctor } from "vite-doctor";

export default {
  plugins: [doctor({ framework: "nitro" })],
};
```

Use the Nuxt module surface for Nuxt-specific configuration:

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
