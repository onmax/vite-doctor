import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { vi } from "vite-plus/test";

interface Condition {
  type: string;
  name?: string;
  conditions?: Condition[];
}

const catalog = JSON.parse(
  readFileSync(
    join(dirname(createRequire(import.meta.url).resolve("detect-agent")), "../agents.json"),
    "utf8",
  ),
) as { aiAgentVar: string; agents: Array<{ match: Condition }> };

export const agentMarkers = new Set<string>([catalog.aiAgentVar]);
const collect = (condition: Condition): void => {
  if (condition.name && condition.name !== "PATH") agentMarkers.add(condition.name);
  condition.conditions?.forEach(collect);
};
for (const agent of catalog.agents) collect(agent.match);

/**
 * Clears every agent marker detect-agent reads, then stubs `env`, so a test sees the same Report
 * Reader inside an agent, in CI, or in a terminal. Undo with `vi.unstubAllEnvs()`.
 */
export function stubReaderEnv(env: Record<string, string | undefined>): void {
  for (const name of agentMarkers) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

/**
 * Writes an MCP server project whose tools break every source MCP Rule, so a run reports enough
 * Diagnostics that the default Report Budget has to hide some.
 */
export function writeMcpToolProject(root: string, tools = 30): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "app",
      type: "module",
      dependencies: { "nitro-mcp-toolkit": "^0.4.0", h3: "^2.0.0" },
    }),
  );
  const dir = join(root, "server/mcp/tools");
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < tools; index++) {
    const output = index % 2 ? "JSON.stringify({ index }, null, 2)" : "'ok'";
    writeFileSync(
      join(dir, `tool-${index}.ts`),
      `import { defineMcpTool } from 'nitro-mcp-toolkit'\nexport default defineMcpTool({ name: 'tool ${index} with spaces', handler: () => ${output} })\n`,
    );
  }
}
