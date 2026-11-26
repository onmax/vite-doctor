import { determineAgent, KNOWN_AGENTS, type AgentResult, type KnownAgentNames } from "detect-agent";
import { detectProvider } from "std-env";
import type { DoctorReportFormat } from "../primitives.js";
import { DEFAULT_REPORT_BUDGET } from "./report-budget.js";

/** Who Doctor assumes reads a report when no `--format` is given. */
export type ReportReader = "agent" | "ci" | "terminal" | "pipe";

export interface DoctorPresentation {
  format: DoctorReportFormat;
  reader: ReportReader;
  detectedAgent?: string;
  /** The agent report was picked because an agent reads it, not because the caller asked. */
  automatic: boolean;
}

export interface AgentRuntime {
  ci: boolean;
  tty: boolean;
  /** Whether the `AI_AGENT` standard names the agent running Doctor. */
  declared: () => boolean;
  determineAgent: () => Promise<AgentResult>;
}

// Agents that only run commands for a model, so their marker holds in a terminal and in CI. Other
// catalog markers can linger in a human's shell (Cursor's integrated terminal sets
// CURSOR_TRACE_ID), so they count only when output goes to a pipe outside CI.
const commandRunningAgents: ReadonlyArray<[KnownAgentNames, (env: NodeJS.ProcessEnv) => boolean]> =
  [
    [
      KNOWN_AGENTS.CURSOR_CLI,
      (env) => Boolean(env.CURSOR_AGENT) || env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec",
    ],
    [KNOWN_AGENTS.GEMINI, (env) => Boolean(env.GEMINI_CLI)],
    [
      KNOWN_AGENTS.CODEX,
      (env) =>
        Boolean(
          env.CODEX_SANDBOX ||
          env.CODEX_CI ||
          env.CODEX_THREAD_ID ||
          env.CODEX_SANDBOX_NETWORK_DISABLED,
        ),
    ],
    [KNOWN_AGENTS.AUGMENT_CLI, (env) => Boolean(env.AUGMENT_AGENT)],
    [KNOWN_AGENTS.OPENCODE, (env) => Boolean(env.OPENCODE_CLIENT || env.OPENCODE)],
    [
      KNOWN_AGENTS.COWORK,
      (env) => Boolean(env.CLAUDE_CODE_IS_COWORK && (env.CLAUDECODE || env.CLAUDE_CODE)),
    ],
    [KNOWN_AGENTS.CLAUDE, (env) => Boolean(env.CLAUDECODE || env.CLAUDE_CODE)],
  ];
const commandRunningAgentNames = new Set<string>(commandRunningAgents.map(([name]) => name));

// The Doctor process swaps the environment per run, so read it at call time.
function currentRuntime(): AgentRuntime {
  const env = process.env;
  const declared = () => Boolean(env.AI_AGENT?.trim());
  return {
    // std-env's isCI is fixed at import; this is the same test on the current environment.
    ci: Boolean(process.env.CI) || detectProvider().ci !== false,
    tty: process.stdout?.isTTY === true,
    declared,
    async determineAgent() {
      if (declared()) return determineAgent();
      const strong = commandRunningAgents.find(([, matches]) => matches(env));
      return strong ? { isAgent: true, agent: { name: strong[0] } } : determineAgent();
    },
  };
}

export async function selectDoctorPresentation(
  explicitFormat?: DoctorReportFormat,
  runtime: AgentRuntime = currentRuntime(),
): Promise<DoctorPresentation> {
  let agent: string | undefined;
  try {
    const result = await runtime.determineAgent();
    if (result.isAgent) agent = result.agent.name;
  } catch {}

  const strong = agent !== undefined && (runtime.declared() || commandRunningAgentNames.has(agent));
  const reader: ReportReader = strong
    ? "agent"
    : runtime.ci
      ? "ci"
      : runtime.tty
        ? "terminal"
        : agent !== undefined
          ? "agent"
          : "pipe";
  const format = explicitFormat ?? (reader === "agent" ? "agent" : "text");
  return {
    format,
    reader,
    ...(reader === "agent" ? { detectedAgent: agent } : {}),
    automatic: !explicitFormat && format === "agent",
  };
}

/** The Report Budget when the caller sets none: CI logs keep the complete text report. */
export function defaultReportBudget(reader: ReportReader, format: DoctorReportFormat): number {
  return reader === "ci" && format === "text" ? Infinity : DEFAULT_REPORT_BUDGET;
}
