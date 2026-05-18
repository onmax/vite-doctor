# Shared Doctor Run

CLI surfaces and plugin surfaces share one Doctor Run concept rather than owning separate execution paths. Each surface can prepare host-specific options, project inventory, and runtime evidence, but reporting and failure policy remain surface-specific: CLIs exit, and build-tool plugins fail or warn through the host system.

Structured reports and `nostics`-backed diagnostics are outputs of a Doctor Run, not separate execution paths. Agent consumers use those outputs rather than a Doctor-owned MCP tool surface.
