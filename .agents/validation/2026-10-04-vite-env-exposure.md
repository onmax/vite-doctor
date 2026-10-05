# Vite environment exposure validation

A server-only TypeScript module in the official Astro basics example read `import.meta.env.PRIVATE_API_SECRET`. Astro rendered its boolean state successfully and emitted none of the synthetic secret value into public output. Doctor's CLI and Vite Plugin Surface both rejected the source with `VITE0009` before this change.

## Resolved host evidence

The Vite Plugin Surface now contributes the resolved `envPrefix` names and explicit `define` key names as Runtime Evidence. It includes definitions from resolved Vite environments. It does not retain environment or define values. Evidence also records the host root so a Doctor Run targeting another root cannot use it to suppress findings.

`vite/env/no-client-secret-pattern` reports names matching a public prefix, explicit per-key defines, and possible whole-object defines. Public prefixes remain reportable during SSR. Names outside those exposure paths are ignored only when the Runtime Evidence is complete, valid and belongs to the analyzed root. Missing, malformed, sparse-array and unrelated-root evidence preserves conservative behavior.

The CLI has no resolved host evidence and keeps reporting suspicious names. This change does not execute `vite.config.*`, `astro.config.*`, or executable Doctor configuration from the CLI. The Plugin Surface continues to accept in-memory configuration and does not load executable Doctor configuration.

## Authoritative behavior

The official Vite documentation at revision `10033218d239c927cdc375970b5741cce408e81b`, [`docs/guide/env-and-mode.md`](https://github.com/vitejs/vite/blob/10033218d239c927cdc375970b5741cce408e81b/docs/guide/env-and-mode.md), distinguishes exposed `VITE_*` variables from a private `DB_PASSWORD` and documents custom prefixes.

Astro 7.3.5 sets `envPrefix` to `settings.config.vite?.envPrefix ?? "PUBLIC_"` in `dist/core/create-vite.js`. The fix consumes that resolved host value without adding an Astro-specific rule branch or trying to infer client/server reachability from filenames.

## Packed Astro reproduction

The fixture is the official [`withastro/astro` basics example](https://github.com/withastro/astro/tree/4c1470a7f907fe678ef5e7dceaa972ca83d297da/examples/basics), pinned to `4c1470a7f907fe678ef5e7dceaa972ca83d297da`. A standalone copy avoids references to omitted source directories in the sparse upstream monorepo. Installation used `--ignore-scripts --no-audit --no-fund`. The actual host is Astro 7.3.5 with Vite 8.3.2 on Node 24.21.0. Astro telemetry was disabled.

The host configuration contains:

```js
import { defineConfig } from "astro/config";
import { doctor } from "vite-doctor/plugin";

export default defineConfig({
  vite: { plugins: [doctor({ rules: "vite", cache: false })] },
});
```

A temporary module exports:

```ts
export const serverTokenConfigured = Boolean(import.meta.env.PRIVATE_API_SECRET);
```

The page imports it in Astro frontmatter and renders the boolean as an attribute. The validation supplies `PRIVATE_API_SECRET=doctor-validation-private-server-marker`, checks that the rendered boolean is true, and verifies that no file in public `dist` contains the marker.

| Case                                                      | Before              | After               |
| --------------------------------------------------------- | ------------------- | ------------------- |
| Host build with Doctor disabled                           | Pass, marker absent | Pass, marker absent |
| Private server module, CLI                                | VITE0009, exit 1    | VITE0009, exit 1    |
| Private server module, Plugin Surface                     | VITE0009, exit 1    | Pass, marker absent |
| Public-prefix read in imported TypeScript, CLI            | VITE0009, exit 1    | VITE0009, exit 1    |
| Public-prefix read in imported TypeScript, Plugin Surface | VITE0009, exit 1    | VITE0009, exit 1    |
| Public-prefix read inside `.astro` client script          | No finding          | No finding          |
| Restored host sources                                     | Pass                | Pass                |

The `.astro` result is an existing source coverage gap. Doctor currently inventories supported JavaScript, TypeScript and Vue sources, not Astro component regions. This validation does not claim complete Astro analysis.

The packed build has SHA-256 `33923cdf3ebba1bb84930eb4f0c86ee50c982cef12282849e5809fe7a5e2bd4a`. The original before-fix logs remain intact. After-fix logs and the tarball are under `artifacts/env-exposure` in `/home/maxi/.cache/doctor-framework-validation`; the scripts are `validate-astro-server-env-after.py` and `validate-astro-after.py`.

## Verification

The initial regression suite failed eight cases before implementation. A separate per-environment define test failed until the Plugin Surface collected environment-specific definitions. Two sparse-array tests failed until malformed evidence validation rejected array holes.

All 31 environment exposure tests now pass. They use actual Vite builds for default, custom, multiple and empty-array prefixes, SSR, explicit defines, whole-object defines, environment-specific defines, and host rejection of an empty-string prefix. Additional cases cover absent or malformed evidence, root ownership, value privacy and the executable configuration boundary.

The full suite passed 4,542 tests across 49 files. `vp check` passed with no warnings, lint errors or type errors after test-only formatting and sparse-array construction cleanup. `pnpm pack` ran the production build successfully. An independent agent reviewed host evidence ownership, conservative fallback behavior, environment definitions and tests before publication.
