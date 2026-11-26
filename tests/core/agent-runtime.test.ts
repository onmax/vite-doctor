import { expect, test } from "vite-plus/test";
import {
  defaultReportBudget,
  selectDoctorPresentation,
  type AgentRuntime,
} from "../../src/core/internal/agent-runtime.ts";

const states = [
  { ci: false, tty: true },
  { ci: true, tty: false },
  { ci: true, tty: true },
  { ci: false, tty: false },
];

test("an explicit format keeps the reader, which is the agent only when a strong agent runs Doctor", async () => {
  await expect(
    selectDoctorPresentation("sarif", runtime({ ci: true, tty: true }, "codex_cli")),
  ).resolves.toEqual({
    format: "sarif",
    reader: "agent",
    detectedAgent: "codex_cli",
    automatic: false,
  });
  await expect(
    selectDoctorPresentation("text", runtime({ ci: true, tty: false }, "cursor")),
  ).resolves.toEqual({ format: "text", reader: "ci", automatic: false });
  await expect(
    selectDoctorPresentation("text", runtime({ ci: true, tty: false }, "claude_code")),
  ).resolves.toEqual({
    format: "text",
    reader: "agent",
    detectedAgent: "claude_code",
    automatic: false,
  });
});

test("a strong agent gets the agent report in a terminal, in CI, and in both", async () => {
  const names = [
    "claude_code",
    "cowork",
    "codex_cli",
    "cursor-cli",
    "gemini_cli",
    "open_code",
    "augment-cli",
  ];
  for (const name of names) {
    for (const state of states) {
      await expect(selectDoctorPresentation(undefined, runtime(state, name))).resolves.toEqual({
        format: "agent",
        reader: "agent",
        detectedAgent: name,
        automatic: true,
      });
    }
  }
});

test("AI_AGENT makes any agent name strong", async () => {
  await expect(
    selectDoctorPresentation(undefined, runtime({ ci: true, tty: true }, "my-agent", true)),
  ).resolves.toEqual({
    format: "agent",
    reader: "agent",
    detectedAgent: "my-agent",
    automatic: true,
  });
});

test("a weak agent gets text in a terminal and in CI, and the agent report when piped", async () => {
  for (const name of ["cursor", "kiro", "replit", "goose", "github-copilot", "pi", "devin"]) {
    await expect(
      selectDoctorPresentation(undefined, runtime({ ci: false, tty: true }, name)),
    ).resolves.toEqual({ format: "text", reader: "terminal", automatic: false });
    await expect(
      selectDoctorPresentation(undefined, runtime({ ci: true, tty: false }, name)),
    ).resolves.toEqual({ format: "text", reader: "ci", automatic: false });
    await expect(
      selectDoctorPresentation(undefined, runtime({ ci: false, tty: false }, name)),
    ).resolves.toEqual({ format: "agent", reader: "agent", detectedAgent: name, automatic: true });
  }
});

test("without an agent the reader is CI, a terminal, or a pipe", async () => {
  const cases = [
    [{ ci: true, tty: true }, "ci"],
    [{ ci: true, tty: false }, "ci"],
    [{ ci: false, tty: true }, "terminal"],
    [{ ci: false, tty: false }, "pipe"],
  ] as const;
  for (const [state, reader] of cases) {
    await expect(selectDoctorPresentation(undefined, runtime(state))).resolves.toEqual({
      format: "text",
      reader,
      automatic: false,
    });
  }
});

test("a failing detection keeps the text report", async () => {
  for (const state of states) {
    const presentation = await selectDoctorPresentation(undefined, {
      ...state,
      declared: () => true,
      determineAgent: async () => {
        throw new Error("detection failed");
      },
    });
    expect(presentation).toMatchObject({ format: "text", automatic: false });
    expect(presentation.reader).not.toBe("agent");
  }
});

test("only CI reading text has no default Report Budget", () => {
  expect(defaultReportBudget("ci", "text")).toBe(Infinity);
  expect(defaultReportBudget("ci", "agent")).toBe(8000);
  for (const reader of ["agent", "terminal", "pipe"] as const) {
    expect(defaultReportBudget(reader, "text")).toBe(8000);
    expect(defaultReportBudget(reader, "agent")).toBe(8000);
  }
});

function runtime(
  state: { ci: boolean; tty: boolean },
  agent?: string,
  declared = false,
): AgentRuntime {
  return {
    ...state,
    declared: () => declared,
    determineAgent: async () =>
      agent ? { isAgent: true, agent: { name: agent } } : { isAgent: false, agent: undefined },
  };
}
