import { readFileSync } from "node:fs";
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

const markers = new Set<string>([catalog.aiAgentVar]);
const collect = (condition: Condition): void => {
  if (condition.name && condition.name !== "PATH") markers.add(condition.name);
  condition.conditions?.forEach(collect);
};
for (const agent of catalog.agents) collect(agent.match);

/**
 * Clears every agent marker detect-agent reads, then stubs `env`, so a test sees the same Report
 * Reader inside an agent, in CI, or in a terminal. Undo with `vi.unstubAllEnvs()`.
 */
export function stubReaderEnv(env: Record<string, string>): void {
  for (const name of markers) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}
