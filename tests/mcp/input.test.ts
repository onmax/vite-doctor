import { describe, expect, test } from "vite-plus/test";
import { checkMcpToolList, checkMcpToolResult } from "../../src/mcp/index.ts";

const tool = { name: "search", description: "Search.", inputSchema: { type: "object" } };
const rules = (input: unknown) =>
  checkMcpToolList(input, { clients: ["vscode"] }).map((finding) => finding.rule);

describe("tools/list input", () => {
  test("accepts a tools array, { tools }, { initialize, tools } and a JSON-RPC response", () => {
    const bare = { ...tool, description: undefined };
    const expected = ["vscode/missing-description"];
    expect(rules([bare])).toEqual(expected);
    expect(rules({ tools: [bare] })).toEqual(expected);
    expect(rules({ initialize: { serverInfo: { name: "x" } }, tools: [bare] })).toEqual(expected);
    expect(rules({ jsonrpc: "2.0", id: 2, result: { tools: [bare], nextCursor: "" } })).toEqual(
      expected,
    );
  });

  test("passes the initialize result to server rules", () => {
    const findings = checkMcpToolList(
      { initialize: { instructions: "i".repeat(5_000) }, tools: [tool] },
      { clients: ["claude-code"] },
    );
    expect(findings.map((finding) => finding.rule)).toContain("claude-code/instructions-length");
  });

  test("rejects input it does not recognize", () => {
    expect(() => checkMcpToolList({ result: { tools: [] } })).toThrow(TypeError);
    expect(() => checkMcpToolList("tools")).toThrow(TypeError);
    expect(() => checkMcpToolList(undefined)).toThrow(TypeError);
    expect(() => checkMcpToolList([{ description: "no name" }])).toThrow(/tools\[0\]/);
    expect(() => checkMcpToolList({ tools: [tool, { name: 3 }] })).toThrow(/tools\[1\]/);
  });

  test("rejects unknown clients", () => {
    expect(() => checkMcpToolList([tool], { clients: ["claude-desktop" as never] })).toThrow(
      /Unknown MCP client "claude-desktop"/,
    );
  });

  test("checks every client by default", () => {
    const clients = new Set(checkMcpToolList([{ name: "a/b" }]).map((finding) => finding.client));
    expect([...clients].sort()).toEqual(
      ["chatgpt", "claude-directory", "codex", "gemini-cli", "vscode"].sort(),
    );
  });
});

describe("tools/call input", () => {
  test("accepts a result and a JSON-RPC response", () => {
    const result = { content: [{ type: "text", text: "x".repeat(150_001) }] };
    const rules = (input: unknown) =>
      checkMcpToolResult(input, { clients: ["claude"] }).map((finding) => finding.rule);
    expect(rules(result)).toEqual(["claude/result-size"]);
    expect(rules({ ...result, jsonrpc: "2.0" })).toEqual(["claude/result-size"]);
    expect(rules({ jsonrpc: "2.0", id: 1, result })).toEqual(["claude/result-size"]);
  });

  test("rejects input it does not recognize", () => {
    expect(() => checkMcpToolResult({ content: "text" })).toThrow(TypeError);
    expect(() => checkMcpToolResult([])).toThrow(TypeError);
    expect(() => checkMcpToolResult(null)).toThrow(TypeError);
  });

  test("rejects a JSON-RPC error response instead of passing it as an empty result", () => {
    const error = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool" } };
    expect(() => checkMcpToolResult(error)).toThrow(
      "Expected a JSON-RPC tools/call result, got an error response -32602: Unknown tool.",
    );
    expect(() => checkMcpToolList(error)).toThrow(/tools\/list result, got an error response/);
    expect(() => checkMcpToolResult({ jsonrpc: "2.0", id: 1 })).toThrow(TypeError);
  });
});
