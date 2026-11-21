const inlineSuppression = /(?:^|\s)doctor-disable(-next-line)?\s+([^\s]+)(?:\s+--\s+(.+)|\s+(.+))?/;

export function matchInlineSuppression(segment: string): RegExpMatchArray | null {
  return segment.match(inlineSuppression);
}

export function containsInlineSuppression(body: string): boolean {
  return body.includes("doctor-disable") && body.split("\n").some(matchInlineSuppression);
}
