import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const mcpDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "MCP0001", ruleId: "mcp/tools/require-annotation-title" },
  { code: "MCP0002", ruleId: "mcp/tools/require-safety-hint" },
  { code: "MCP0003", ruleId: "mcp/tools/valid-name" },
]);

export const diagnostics = mcpDiagnosticRegistry.diagnostics;
