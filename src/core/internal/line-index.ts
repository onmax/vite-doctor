const MAX_CACHED_SOURCES = 32;

const lineStartsBySource = new Map<string, number[]>();
let lastSource: string | undefined;
let lastLineStarts: number[] = [0];

/**
 * Line and column (both 1-based) for the end of `source.slice(0, offset)`.
 * Only `\n` ends a line, so `\r\n` counts once and a lone `\r` is an ordinary character.
 */
export function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  const position = clampLikeSlice(offset, source.length);
  const lineStarts = getLineStarts(source);
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (lineStarts[middle]! <= position) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: position - lineStarts[low]! + 1 };
}

function getLineStarts(source: string): number[] {
  if (source === lastSource) return lastLineStarts;
  let lineStarts = lineStartsBySource.get(source);
  if (!lineStarts) {
    lineStarts = computeLineStarts(source);
    if (lineStartsBySource.size >= MAX_CACHED_SOURCES) {
      lineStartsBySource.delete(lineStartsBySource.keys().next().value!);
    }
    lineStartsBySource.set(source, lineStarts);
  }
  lastSource = source;
  lastLineStarts = lineStarts;
  return lineStarts;
}

function computeLineStarts(source: string): number[] {
  const lineStarts = [0];
  let index = source.indexOf("\n");
  while (index !== -1) {
    lineStarts.push(index + 1);
    index = source.indexOf("\n", index + 1);
  }
  return lineStarts;
}

// Mirrors String.prototype.slice end-index handling so callers keep their previous results for
// negative, fractional, NaN, or out-of-range offsets.
function clampLikeSlice(offset: number | undefined, length: number): number {
  if (offset === undefined) return length;
  let position = Math.trunc(offset);
  if (Number.isNaN(position)) return 0;
  if (position < 0) position = Math.max(length + position, 0);
  return Math.min(position, length);
}
