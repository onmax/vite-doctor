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

Vite Doctor reads app code, build config, project metadata, and server handlers to catch framework bugs before review. It resolves the installed Nuxt, Nitro, and H3 runtime graph and picks diagnostics that match the versions the framework actually loads.

Need a narrower Doctor Run? Select exact presets, one Rule, or a framework override:

```bash
pnpm dlx vite-doctor . --extends vite/recommended,vue/recommended
pnpm dlx vite-doctor . --rules nuxt/fetch/no-raw-fetch-in-setup
pnpm dlx vite-doctor . --framework nitro
```

`--changed` analyzes complete changed files for framework context, then reports only Diagnostics owned by staged, unstaged, or untracked lines:

```bash
pnpm dlx vite-doctor . --changed
pnpm dlx vite-doctor . --since origin/main
```

Doctor recognizes coding-agent runtimes through Vercel's agent catalog and returns a compact agent report when output is non-interactive. An explicit format always wins:

```bash
pnpm dlx vite-doctor . --format text
pnpm dlx vite-doctor . --format agent
pnpm dlx vite-doctor . --format json
pnpm dlx vite-doctor . --format sarif
```

Agent reports use relative locations and include remediation, Diagnostic Reference URLs, and command templates for explanation, focused verification, and the full rerun.

For Nuxt projects, install Vite Doctor and run it through Nuxt:

```bash
pnpm add -D vite-doctor
pnpm nuxt doctor
```

Use `--framework` only when Doctor cannot identify the framework automatically.

Check a migration before changing dependencies:

```bash
pnpm dlx vite-doctor migrate .
pnpm dlx vite-doctor migrate . --to nuxt@5 --format json
pnpm dlx vite-doctor migrate . --to nitro@3
```

The migration report stages source changes that are safe on the installed runtime, then dependency, configuration, and source changes that must land together, followed by checks that require the target runtime. It does not rewrite the project.

## Configuration

Doctor automatically loads declarative `doctor.config.json` without executing project code:

```json
{
  "rules": {
    "vite/define/no-secret-define": "error"
  }
}
```

Executable config remains explicit because loading it runs project code:

```ts
// doctor.config.ts
import { defineDoctorConfig } from "vite-doctor/config";

export default defineDoctorConfig({
  rules: {
    "vite/define/no-secret-define": "error",
  },
});
```

```bash
pnpm dlx vite-doctor . --config doctor.config.ts
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
