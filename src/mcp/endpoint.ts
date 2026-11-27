import { parseMcpEndpoint } from "@loadsheet/mcp";
import { sha256 } from "../core/internal/utils.js";

export function mcpEndpointId(value: string): string | undefined {
  const url = parseMcpEndpoint(value);
  return url && sha256(`${url.origin}${url.pathname}${url.search}`);
}
