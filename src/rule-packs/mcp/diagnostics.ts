import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const mcpDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "MCP0001", ruleId: "mcp/tools/require-annotation-title" },
  { code: "MCP0002", ruleId: "mcp/tools/require-safety-hint" },
  { code: "MCP0003", ruleId: "mcp/tools/valid-name" },
  { code: "MCP0004", ruleId: "mcp/tools/no-indented-json-output" },
  { code: "MCP0005", ruleId: "mcp/clients/no-excluded-tool" },
  { code: "MCP0006", ruleId: "mcp/clients/no-truncated-text" },
  { code: "MCP0007", ruleId: "mcp/clients/no-rewritten-schema" },
  { code: "MCP0008", ruleId: "mcp/clients/no-stripped-constraint" },
  { code: "MCP0009", ruleId: "mcp/clients/no-reduced-context" },
]);

export const diagnostics = mcpDiagnosticRegistry.diagnostics;
