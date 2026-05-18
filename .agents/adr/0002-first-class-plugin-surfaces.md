# First-Class Plugin Surfaces

Doctor treats plugin surfaces as first-class product surfaces alongside CLI surfaces. Plugin surfaces are framework or build-tool integrations that run Doctor inside the host system and can contribute project inventory and runtime evidence, not only decide when Doctor runs. This makes framework-native usage through integrations such as the Vite plugin, Nuxt module, and future ecosystem integrations part of the core architecture rather than wrappers around the CLI.

MCP is not a Doctor product surface. Agent-oriented usage is diagnostics-first: agent consumers run Doctor or consume Doctor reports instead of connecting to a Doctor-owned MCP server.
