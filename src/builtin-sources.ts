import type { EvidenceSource } from "./core/primitives.js";
import { mcpEvidenceSource } from "./mcp/evidence.js";

/** Evidence Sources Doctor ships. The CLI declares their flags so `--help` lists them. */
export const builtinEvidenceSources: readonly EvidenceSource[] = [mcpEvidenceSource];
