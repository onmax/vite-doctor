# Framework Plugin Surface validation

Validated on 2026-10-04 with Node 24.21.0. Doctor was built from `7c3b7fa` plus the Plugin Surface lifecycle fix in this change. No framework adapter was added.

## Projects and installation

| Project      | Upstream revision                                                                                                                                       | Fixture                | Installed host                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------- |
| React Router | [`067adb378a00a4c2ceb71934d5e8901d0e87c256`](https://github.com/remix-run/react-router-templates/tree/067adb378a00a4c2ceb71934d5e8901d0e87c256/default) | `default`              | React Router 8.4.0, Vite 8.3.2   |
| Next.js      | [`ba80ee48fc319735151c3ad6d9bb9a8180c9f09e`](https://github.com/vercel/next.js/tree/ba80ee48fc319735151c3ad6d9bb9a8180c9f09e/examples/hello-world)      | `examples/hello-world` | No Next.js installation or build |

The official repositories were shallow, filtered clones under `/tmp`. Their clone directories are symlinks into `/home/maxi/.cache/doctor-framework-validation` because `/tmp` was full.

The React Router template's documented `npm install` was run with `--ignore-scripts --no-audit --no-fund`. Its pristine `npm run build` built both client and SSR environments successfully. The Doctor tarball was then installed into this independent project with the same script restriction. The tarball's SHA-256 is `1ba744e5819d6aa4fef996455bbe040d5916597721725103276c1ec751a7db8e`.

## CLI and package entrypoints

The pristine Next.js fixture produced no diagnostics. A temporary `app/doctor-validation.ts` containing this source produced `TS0001` and exit 1:

```ts
export const asserted = {} as unknown as string;
```

The installed CLI entrypoint and imported `main` from `vite-doctor/cli` produced identical diagnostics with `--rules typescript/evidence/no-chained-type-assertions --no-cache --format json`. The temporary file was removed after validation.

The pristine React Router CLI run produced 11 existing `SHAD0002` and `SHAD0003` warnings from the welcome component. The shadcn Rule Pack currently activates on `tailwindcss`; these findings do not establish React Router-specific analysis.

The React Router Vite configuration then registered:

```ts
import { doctor } from "vite-doctor/plugin";

// Added alongside the template's existing plugins.
doctor({ rules: "vite", cache: false });
```

The host build passed with one Doctor Run before the client build and a completed SSR build. Adding `export const doctorValidationSecret = import.meta.env.VITE_API_SECRET` to `app/root.tsx` produced `VITE0009` and exit 1 through both the installed CLI and the Plugin Surface imported from `vite-doctor`. After restoring the source, the Plugin Surface imported from `vite-doctor/plugin` built both environments successfully.

## SvelteKit host and source coverage

The official [`sveltejs/kit-template-default`](https://github.com/sveltejs/kit-template-default/tree/5fbe14c3b26e9932cbb558d52a3db6bfd367d7c4) repository was cloned at `5fbe14c3b26e9932cbb558d52a3db6bfd367d7c4` into `/tmp/doctor-campaign-sveltekit-official`, also backed by disk through a symlink. Installation with scripts disabled resolved SvelteKit 3.0.0, Svelte 5.57.1 and Vite 8.3.2. Its pristine SSR and client builds passed.

The same Doctor tarball was installed, and its Plugin Surface was added alongside `sveltekit()` in `vite.config.js`. The actual host build passed with one Doctor Run before the SSR environment, followed by the client build. Adapter-auto reported that no deployment platform was detected, as expected for this local build.

A read of `import.meta.env.VITE_API_SECRET` inside the script block of `src/routes/+page.svelte` produced no diagnostics through the CLI or host build. Doctor reported four analyzed files. Moving that expression into an imported `src/lib/doctor-validation.js` produced `VITE0009`, five analyzed files, and exit 1 through both entrypoints. No secret value was supplied. The component was restored and the temporary module removed; both host build environments then passed again.

This comparison demonstrates a source-language coverage gap. Doctor currently excludes `.svelte` components from its source inventory and parser. The successful host integration proves Vite rules on supported JavaScript and TypeScript sources, not Svelte component or SvelteKit runtime diagnostics. The automated reproduction and its logs remain in `validate-sveltekit.py` and `artifacts/sveltekit-*` under the local evidence directory.

## Reused Plugin Surface regression

A script imported Vite's actual `build` API from the installed React Router project and reused one `doctor()` instance across two separately resolved builds. It built the template's `app/routes.ts` as a library entry with `@react-router/dev/routes` externalized and output writes disabled.

The first build was clean. Before the second build, the script created an authored source file containing `import.meta.env.VITE_API_SECRET`. Before the fix, the second build passed without running Doctor, and `assert.rejects` failed. After the fix, the second build failed with `VITE0009`, and the assertion passed. The script removed its seeded source file in `finally`.

`src/plugin.ts` kept `ran` in the plugin instance's closure without resetting it when Vite supplied a new resolved configuration. Resetting it in `configResolved` gives each new host configuration a Doctor Run. The regression test uses Vite's real build API. A second test uses `createBuilder` with shared client and SSR plugins and verifies that a single application build still produces one Doctor Run.

This change does not add diagnostics on watch rebuilds within the same resolved configuration, or support concurrent builds that reuse one plugin object.

## Coverage limits and follow-ups

Next.js configures Turbopack or webpack, as described in its [Turbopack configuration reference at the validated revision](https://github.com/vercel/next.js/blob/ba80ee48fc319735151c3ad6d9bb9a8180c9f09e/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.mdx). It has no applicable Vite Plugin Surface here. Doctor currently reports its fallback framework as `vite`; the Next.js results prove generic TypeScript analysis only. They do not establish Next.js framework rules or runtime analysis.

React Router's actual multi-environment build establishes compatibility of the Vite Plugin Surface for the exercised Vite rules. Doctor's current Vite Runtime Evidence reads top-level `build.ssr` and does not describe all resolved Vite environments. Framework routes, generated server entries, and client/server module reachability need explicit Project Inventory and Runtime Evidence before framework-specific diagnostics can be claimed. SvelteKit host and source coverage were tested above. Remix was not validated in this run.

## Verification and local evidence

- The reused-build regression failed before the fix and passed after it.
- The targeted lifecycle and CLI tests passed, 51 tests.
- The complete suite passed, 4,430 tests across 44 files.
- `vp check` and `tsdown` passed.
- An independent agent reviewed the fix and reran both lifecycle tests successfully.
- The original installed-Vite reproduction and packed-package starter validations passed.

Local reports, build logs, the tarball, and reproducer scripts remain in `/home/maxi/.cache/doctor-framework-validation`. The `artifacts` directory contains pristine and seeded CLI reports, imported CLI reports, host build logs, and `plugin-reuse-before.log` / `plugin-reuse-after.log`.
