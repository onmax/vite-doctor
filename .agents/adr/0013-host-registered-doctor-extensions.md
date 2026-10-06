# Host-Registered Doctor Extensions

Libraries that ship a host integration register their Doctor Extensions through that host. This is still the explicit registration from ADR 0005: the user installs the library's Vite plugin or Nuxt module, and the library registers its extension through a documented host contract. Doctor does not scan installed packages or `package.json` fields.

**Vite Plugin Surface.** A Vite plugin exposes `api.doctor = { extensions }` on its plugin object, typed as `DoctorPluginApi`. The `doctor()` plugin reads that field from every plugin in the resolved Vite config, in plugin order, after its own `extensions` option. Entries can be extensions or loaders, so libraries only import Doctor code when a Doctor Run needs it. Vite config is trusted host config, so no extra opt-in is needed.

**Nuxt 4 Bridge.** A Nuxt module calls the typed `doctor:extendExtensions` hook and pushes entry modules: absolute paths, `file:` URLs, or specifiers that resolve from the Nuxt root. The default export of each entry must be a Doctor Extension. The bridge records the resolved absolute paths in `.nuxt/doctor.manifest.json`, because the Nuxt Doctor Command runs in a different process from Nuxt and cannot receive in-memory objects. The earlier in-memory `doctor:extendRules` hook was removed. Nothing collected its Rule Packs into a Doctor Run.

**Trust boundary.** Loading recorded entries runs code, so the CLI Surface opts in explicitly:

- The Nuxt Doctor Command (`nuxt doctor`, through the `nuxt-doctor` host-command shim) loads recorded entries. Running a Nuxt host command is the same trust decision as `nuxt dev` or `nuxt prepare`, which already ran those modules.
- The standalone `vite-doctor` CLI loads recorded entries only when `--host-extensions` is passed. Without the flag, it keeps its guarantee that it does not run project code unless the user selects `--config`.
- Agent rerun and explain commands keep `--host-extensions` so verification runs see the same Rule Packs.

**Identity and ordering.** The Doctor Extension `name` is the extension's identity. A Doctor Run registers each name once, and the first registration wins. This makes the same extension safe to register through config, plugin options, a host plugin, and the Nuxt manifest. Order is deterministic: config extensions, built-in extensions, explicit surface extensions, extensions discovered from host plugins, then host-recorded entries.

**Diagnostic Codes.** Rule Packs declare their codes with `defineDoctorDiagnostics` and attach the registry as `RulePack.diagnostics`. Built-in Diagnostic Code Prefixes (`DOC`, `NITRO`, `NUXT`, `PINIA`, `PKG`, `SHAD`, `TS`, `VITE`, `VUE`) are reserved. Declaring or reporting an unregistered code with a reserved prefix fails with `DOC0028`. Codes must be an uppercase prefix followed by four digits (`DOC0027`). Third-party codes get documentation URLs only from their owner's `docsBase` or per-code `docs`. Doctor does not create Diagnostic Reference URLs for prefixes it does not own.
