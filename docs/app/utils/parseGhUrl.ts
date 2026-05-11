export interface GhRef {
  owner: string;
  repo: string;
  ref: string;
}

export class GhUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhUrlError";
  }
}

const GH_HOST_RE = /^https?:\/\/github\.com\//i;
const SHORT_RE = /^([a-z0-9][\w.-]*)\/([\w.-]+?)(?:#([\w.\-/]+))?$/i;

export function parseGhUrl(input: string): GhRef {
  const raw = input.trim();
  if (!raw) throw new GhUrlError("Enter a GitHub URL or owner/repo");

  let stripped = raw.replace(GH_HOST_RE, "").replace(/\.git$/i, "");
  let ref = "HEAD";

  const treeMatch = stripped.match(/^([\w.-]+)\/([\w.-]+)\/tree\/(.+)$/i);
  if (treeMatch)
    return { owner: treeMatch[1]!, repo: treeMatch[2]!, ref: treeMatch[3]!.split(/[?#]/)[0]! };

  stripped = stripped.split("?")[0]!.replace(/\/+$/, "");
  const short = stripped.match(SHORT_RE);
  if (short) return { owner: short[1]!, repo: short[2]!, ref: short[3] ?? ref };

  const simple = stripped.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (simple) return { owner: simple[1]!, repo: simple[2]!, ref };

  throw new GhUrlError("Use owner/repo or https://github.com/owner/repo");
}
