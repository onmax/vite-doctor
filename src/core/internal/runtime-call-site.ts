export const RUNTIME_CALL_SITE = /^(.+):(\d+):(\d+)$/;
export const VITE_HMR_TIMESTAMP = /[?&]t=(\d{13})(?=&|$)/;

/** A generated call site, ignoring Vite's revision marker but retaining module query variants. */
export function runtimeCallSiteKey(source = ""): string {
  const [, url, line, column] = RUNTIME_CALL_SITE.exec(source) ?? [];
  if (!url) return source;
  const timestamp = VITE_HMR_TIMESTAMP.exec(url);
  if (!timestamp) return source;
  const before = url.slice(0, timestamp.index);
  const after = url.slice(timestamp.index + timestamp[0].length);
  const query = timestamp[0].startsWith("?") && after ? `?${after.slice(1)}` : after;
  return `${before}${query}:${line}:${column}`;
}
