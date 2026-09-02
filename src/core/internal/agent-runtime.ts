import { determineAgent, type AgentResult } from "detect-agent";
import { isCI } from "std-env";
import type { DoctorReportFormat } from "../primitives.js";

export interface DoctorPresentation {
  format: DoctorReportFormat;
  detectedAgent?: string;
  automatic: boolean;
}

interface AgentRuntime {
  ci: boolean;
  tty: boolean;
  determineAgent: () => Promise<AgentResult>;
}

const currentRuntime: AgentRuntime = {
  ci: isCI,
  tty: process.stdout?.isTTY === true,
  determineAgent,
};

export async function selectDoctorPresentation(
  explicitFormat?: DoctorReportFormat,
  runtime: AgentRuntime = currentRuntime,
): Promise<DoctorPresentation> {
  if (explicitFormat) return { format: explicitFormat, automatic: false };
  if (runtime.ci || runtime.tty) return { format: "text", automatic: false };

  try {
    const result = await runtime.determineAgent();
    if (result.isAgent) {
      return {
        format: "agent",
        detectedAgent: result.agent.name,
        automatic: true,
      };
    }
  } catch {}

  return { format: "text", automatic: false };
}
