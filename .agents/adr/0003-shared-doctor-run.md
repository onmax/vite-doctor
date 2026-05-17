# Shared Doctor Run

CLI surfaces and plugin surfaces share one Doctor Run concept rather than owning separate execution paths. Each surface can prepare host-specific options, project inventory, and runtime evidence, but reporting and failure policy remain surface-specific: CLIs exit, build-tool plugins fail or warn, and MCP tools return structured results.
