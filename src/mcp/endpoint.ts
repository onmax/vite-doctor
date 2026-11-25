export function parseMcpEndpoint(value: string | URL): URL | undefined {
  const url = URL.parse(value);
  return url?.protocol === "http:" || url?.protocol === "https:" ? url : undefined;
}

/** A report label, not the address used to send the request. */
export function mcpEndpointLabel(value: string): string {
  return parseMcpEndpoint(value)?.origin ?? "<MCP endpoint>";
}
