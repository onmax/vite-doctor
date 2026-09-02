import { expect, test, vi } from "vite-plus/test";
import { selectDoctorPresentation } from "../../src/core/internal/agent-runtime.ts";

test("keeps an explicit report format in an agent runtime", async () => {
  const determineAgent = vi.fn(async () => agent("codex_cli"));

  await expect(
    selectDoctorPresentation("sarif", { ci: true, tty: true, determineAgent }),
  ).resolves.toEqual({ format: "sarif", automatic: false });
  expect(determineAgent).not.toHaveBeenCalled();
});

test("selects agent output for every detected non-interactive coding agent", async () => {
  for (const name of ["codex_cli", "claude_code", "gemini_cli", "custom-agent"]) {
    await expect(
      selectDoctorPresentation(undefined, {
        ci: false,
        tty: false,
        determineAgent: async () => agent(name),
      }),
    ).resolves.toEqual({ format: "agent", detectedAgent: name, automatic: true });
  }
});

test("does not select agent output in CI", async () => {
  const determineAgent = vi.fn(async () => agent("codex_cli"));

  await expect(
    selectDoctorPresentation(undefined, { ci: true, tty: false, determineAgent }),
  ).resolves.toEqual({ format: "text", automatic: false });
  expect(determineAgent).not.toHaveBeenCalled();
});

test("does not select agent output in an interactive terminal", async () => {
  const determineAgent = vi.fn(async () => agent("cursor"));

  await expect(
    selectDoctorPresentation(undefined, { ci: false, tty: true, determineAgent }),
  ).resolves.toEqual({ format: "text", automatic: false });
  expect(determineAgent).not.toHaveBeenCalled();
});

test("keeps text output when no agent is detected", async () => {
  await expect(
    selectDoctorPresentation(undefined, {
      ci: false,
      tty: false,
      determineAgent: async () => ({ isAgent: false, agent: undefined }),
    }),
  ).resolves.toEqual({ format: "text", automatic: false });
});

test("fails open to text output when detection fails", async () => {
  await expect(
    selectDoctorPresentation(undefined, {
      ci: false,
      tty: false,
      determineAgent: async () => {
        throw new Error("detection failed");
      },
    }),
  ).resolves.toEqual({ format: "text", automatic: false });
});

function agent(name: string) {
  return { isAgent: true as const, agent: { name } };
}
