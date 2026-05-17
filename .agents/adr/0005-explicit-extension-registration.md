# Explicit Extension Registration First

Doctor starts with explicit Doctor Extension registration through configuration or host hooks, while keeping the extension format compatible with later discovery. This avoids premature package auto-loading in plugin surfaces, but still lets Nuxt modules, Vite users, and future ecosystem libraries contribute rule packs, project inventory, and runtime evidence intentionally.
