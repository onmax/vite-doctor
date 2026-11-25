import type { McpClientRule } from "../types.js";
import { chatgptRules } from "./chatgpt.js";
import { claudeCodeRules } from "./claude-code.js";
import { claudeDirectoryRules } from "./claude-directory.js";
import { claudeRules } from "./claude.js";
import { codexRules } from "./codex.js";
import { copilotStudioRules } from "./copilot-studio.js";
import { cursorRules } from "./cursor.js";
import { geminiCliRules } from "./gemini-cli.js";
import { vscodeRules } from "./vscode.js";

/** Every client limit Doctor checks, each with the primary source it was read from. */
export const mcpClientRules: readonly McpClientRule[] = [
  ...claudeCodeRules,
  ...claudeRules,
  ...claudeDirectoryRules,
  ...chatgptRules,
  ...codexRules,
  ...cursorRules,
  ...vscodeRules,
  ...geminiCliRules,
  ...copilotStudioRules,
];
