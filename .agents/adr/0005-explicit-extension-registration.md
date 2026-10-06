# Explicit Extension Registration First

Doctor starts with explicit Doctor Extension registration through configuration or host hooks, while keeping the extension format compatible with later discovery. This avoids premature package auto-loading in plugin surfaces, but still lets Nuxt modules, Vite users, and future ecosystem libraries contribute rule packs, project inventory, and runtime evidence intentionally.

Host-registered extensions are specified in ADR 0013: Vite plugins expose `api.doctor`, Nuxt modules use the `doctor:extendExtensions` hook, and the standalone CLI loads host-recorded entries only when the user opts in.
