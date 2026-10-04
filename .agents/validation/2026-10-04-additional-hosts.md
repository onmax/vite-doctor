# Additional official framework host validation

Validated on 2026-10-04 with Node 24.21.0. Doctor was built from `a168931` and installed as a tarball in independent framework projects. This record extends the earlier source-only checks and records actual host builds. It does not add framework Rule Packs.

## Fixtures

| Framework | Official source                                                                                                                                                                                                                      | Installed host                                             | Build exercised                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Remix     | [`remix-run/remix`, `5ff6f9a17add06e7f70da48480c1911ad0a1310f`, `templates/remix`](https://github.com/remix-run/remix/tree/5ff6f9a17add06e7f70da48480c1911ad0a1310f/templates/remix)                                                 | Remix 2.17.5, React 18.3.1, Vite 6.4.3, TypeScript 5.9.3   | Client and SSR production bundles                                            |
| Analog    | [`analogjs/analog`, `a377078ec2c4f5db233e497eefd12b91a16dc0b3`, `packages/create-analog/template-minimal`](https://github.com/analogjs/analog/tree/a377078ec2c4f5db233e497eefd12b91a16dc0b3/packages/create-analog/template-minimal) | Analog 2.8.0, Angular 22.2.1, Vite 8.3.2, TypeScript 6.0.3 | Original client-only configuration, then a separate SSR/server configuration |
| Next.js   | [`vercel/next.js`, `ba80ee48fc319735151c3ad6d9bb9a8180c9f09e`, `examples/hello-world`](https://github.com/vercel/next.js/tree/ba80ee48fc319735151c3ad6d9bb9a8180c9f09e/examples/hello-world)                                         | Next 16.3.8, React 18.3.1, TypeScript 5.9.3                | Turbopack production build, host typecheck, and local production HTTP smoke  |
| Qwik CSR  | [`vitejs/vite`, `10033218d239c927cdc375970b5741cce408e81b`, `packages/create-vite/template-qwik-ts`](https://github.com/vitejs/vite/tree/10033218d239c927cdc375970b5741cce408e81b/packages/create-vite/template-qwik-ts)             | Qwik 1.20.1, Vite 7.3.6, TypeScript 6.0.3                  | `tsc -b` and the official CSR Vite build                                     |

The repositories were cloned and pinned. `/tmp/doctor-campaign-remix-official` and `/tmp/doctor-campaign-analog-official` point to disk-backed clones because the shared `/tmp` filesystem had limited space. Standalone template copies avoid resolving dependencies through the upstream monorepos.

Analog's checked-in template contains generator placeholders. The fixture applies the official generator's skip-Tailwind substitutions and renames `_gitignore` to `.gitignore`. The original template sets `ssr: false` and `static: true`. A second fixture changes only those flags to `ssr: true` and `static: false`, retaining its empty prerender route list. Both configurations built before adding Doctor. The SSR variant produced client, SSR, and server output.

Reference contracts were read from the pinned repositories:

- [Remix Vite commands and configuration](https://github.com/remix-run/remix/blob/5ff6f9a17add06e7f70da48480c1911ad0a1310f/docs/guides/vite.md).
- [Analog SSR configuration](https://github.com/analogjs/analog/blob/a377078ec2c4f5db233e497eefd12b91a16dc0b3/apps/docs-analog/src/content/features/server/server-side-rendering.md).
- [Analog static output configuration](https://github.com/analogjs/analog/blob/a377078ec2c4f5db233e497eefd12b91a16dc0b3/apps/docs-analog/src/content/features/server/static-site-generation.md).

## Remix and Analog entry points and paired controls

External dependencies and the Doctor tarball were installed with `npm install --ignore-scripts --no-audit --no-fund`. The Doctor tarball has SHA-256 `9a7c530821515522f842de760fdb6e484466638a43a2e7140f8dbc99ad6fb1e7`.

The Remix, Analog client-only, and Analog SSR fixtures each passed this sequence:

1. Run the installed `node_modules/.bin/vite-doctor` with `--rules vite/env/no-client-secret-pattern --no-cache --format json`. It reports `status: clean`, no diagnostics, and exit 0.
2. Import `main` from `vite-doctor/cli` with the same argument array. Its diagnostics match the executable CLI.
3. Add `doctor({ rules: "vite/env/no-client-secret-pattern", cache: false, format: "json" })` alongside the existing Vite plugins, importing `doctor` from `vite-doctor`. `npm run build` passes.
4. Append `console.info(import.meta.env.VITE_API_SECRET)` to the authored route source. Remix uses `app/routes/_index.tsx`; Analog uses `src/app/pages/index.page.ts`. No environment value or secret is supplied.
5. Repeat both CLI entry points. Both exit 1 and emit exactly one `VITE0009`. The reported path is the authored route, and slicing its text with the reported start/end offsets yields exactly `import.meta.env.VITE_API_SECRET`.
6. Run the real host build. It exits 1 with `VITE0009` through the Plugin Surface.
7. Restore the source and switch the plugin import to `vite-doctor/plugin`. Both CLI entry points return clean with exit 0, and the host build passes again.

The validator restores the route and Vite configuration in `finally`. Each fixture has ten captured invocations, including an unfiltered baseline. Clean Remix builds contain two Doctor reports, one per resolved client/SSR configuration. Both Analog configurations contain one Doctor report. No assertion assumes that all hosts resolve the same number of configurations.

The unfiltered Remix baseline emits twelve existing `SHAD0002`/`SHAD0003` warnings about the template's Tailwind classes and exits 0. Its Tailwind dependency activates the Shadcn Rule Pack. The unfiltered Analog baselines are clean. The targeted controls above isolate `VITE0009`; they do not claim that the unfiltered Remix template has no findings.

## Next.js controls

The pinned hello-world example was copied to an independent installed project. Its `latest` Next dependency was pinned to 16.3.8. The first production build generated Next's normal build/type files and changed the copied tsconfig's module resolution to `bundler`; it did not modify the official source clone. The [official installation guide](https://nextjs.org/docs/app/getting-started/installation) describes the exercised build/start commands.

Pristine, seeded, and repaired `NEXT_TELEMETRY_DISABLED=1 npm run build` invocations all pass. The seeded real `app/page.tsx` consumes `const message = "Hello, Next.js!" as unknown as string` in its rendered heading. Both the installed CLI and imported `main` exit 1 with exactly one `TS0001` when run with `--rules typescript/evidence/no-chained-type-assertions --no-cache --format json`. Their diagnostics agree. The reported path is `app/page.tsx`, line 2, and the offsets identify the complete chained assertion.

Restoring the original page restores clean reports and exit 0 from both entry points. `node node_modules/typescript/bin/tsc --noEmit` also passes. The built application was started locally with `next start --hostname 127.0.0.1 --port <ephemeral-port>`; GET `/` returned 200 and contained `<h1>Hello, Next.js!</h1>`. The process was stopped after verification. The unfiltered Doctor baseline is clean.

Doctor currently reports `framework: vite` and an empty Runtime Graph for this Turbopack host. This is generic TypeScript analysis of authored TSX. No Vite plugin was inserted into Next, and this validation does not establish Next-specific detection, React Server Component analysis, Turbopack Runtime Evidence, or a Next Plugin Surface.

## Qwik CSR controls and the upstream dependency mismatch

The official Vite template requests Vite `^8.3.1`. The fixture initially pinned Vite 8.3.2, but Qwik 1.20.1 declares `vite >=5 <8`. The initial installation fails with `ERESOLVE`. The fixture pins supported Vite 7.3.6 without a peer override; that host passes the pristine `npm run build`, whose script runs `tsc -b && vite build`. Its optimizer is configured with `qwikVite({ csr: true })`.

The [release-matched Qwik Vite documentation](https://github.com/QwikDev/qwik/blob/4f3ba7d1f6c4264a65e8f66c3990d33701b2939e/packages/docs/src/routes/docs/%28qwik%29/advanced/vite/index.mdx) was read from the official Qwik 1.20.1 source at `4f3ba7d1f6c4264a65e8f66c3990d33701b2939e`. The live Qwik site documents renamed Qwik 2 packages and was not used as the Qwik 1 contract.

The packed `vite-doctor/plugin` export was added alongside `qwikVite`, with the same Vite Rule selection as the Remix/Analog fixtures. The clean build passes. Replacing the real app heading with `<h1>{import.meta.env.VITE_API_SECRET}</h1>` in `src/app.tsx` establishes the finding. With Doctor absent, a production build containing a synthetic environment value emits that value in real client JavaScript. No credential was used.

Both installed CLI entry points then exit 1 with exactly one `VITE0009` at `src/app.tsx`, and their reports agree. The offsets identify the exact environment read. The packed Plugin Surface also fails the actual production build with `VITE0009`. Restoring the app restores passing plugin builds, clean CLI reports, and `tsc -b`; the synthetic value is absent from the repaired JavaScript output. The original host config is restored, and the unfiltered baseline is clean.

This verifies CSR compilation and generic Vite diagnosis with Qwik's optimizer. It does not validate Qwik City, SSR, browser interactivity, resumability-specific diagnostics, or a Qwik Rule Pack.

## Verification and limits

On the exact Doctor source used for the tarball, the complete suite passed 5,085 tests across 72 files. `node_modules/.bin/vp check` passed with two existing redundant `AnyNode` union warnings. `node_modules/.bin/tsdown` produced the 72-file distribution. Packaging used `pnpm --config.ignore-scripts=true pack` after the build.

The Remix/Analog fixtures prove generic Vite diagnostics on supported authored TS/TSX and operation of the packed CLI and Plugin Surface entry points. They do not prove Remix route semantics, Angular template analysis, Analog server-route Runtime Evidence, or framework-specific Rule Packs. Their SSR build results are not deployments or production-server smoke tests. Next and Qwik have the separate limits described above.

Local evidence is under `/home/maxi/.cache/doctor-framework-validation`: `validate-remix-analog.py`, the pinned official clones, standalone `remix-host`, `analog-host`, and `analog-ssr-host` fixtures, and `artifacts/host-matrix`. The artifact directory contains exact commands and exit codes in each `*-matrix.json`, CLI reports, imported-main reports, host build logs, installed versions, and the tarball. Doctor check/build/test logs are under `/home/maxi/.cache/doctor-root-tests/host-matrix-*`.

Next/Qwik evidence is in `NEXT_QWIK_VALIDATION.md` and `artifacts/next-qwik`. The latter contains `validate-next.py`, `validate-qwik.py`, ten recorded Next invocations, twelve recorded Qwik invocations, separate pristine-build logs, exact-range assertions, the archived emitted synthetic marker, source snapshots, lockfiles, and the Next HTTP response. The installed fixtures are accessible through `/tmp/doctor-campaign-next-installed` and `/tmp/doctor-campaign-qwik-installed`. An independent agent reviewed the Remix/Analog receipts; root independently reviewed and reran the Next/Qwik sequences.
