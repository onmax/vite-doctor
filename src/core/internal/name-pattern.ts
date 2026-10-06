const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hexDigits = (value: string) =>
  Array.from(value, (digit) => `[${digit.toLowerCase()}${digit.toUpperCase()}]`).join("");
const escapedNamePattern = (name: string) => {
  const continuation = `(?:\\\\(?:\\r\\n?|\\n|\\u2028|\\u2029))`;
  const character = (value: string) => {
    const code = value.charCodeAt(0);
    const hex = code.toString(16).padStart(2, "0");
    const unicode = code.toString(16).padStart(4, "0");
    const octal = code.toString(8);
    const codePoint = code.toString(16);
    return `(?:${escapeRegex(value)}|\\\\u${hexDigits(unicode)}|\\\\u\\{0*${hexDigits(codePoint)}\\}|\\\\x${hexDigits(hex)}|\\\\${octal}|\\\\(?![uUxX0-7])${escapeRegex(value)})`;
  };
  return `(?:${continuation}*${Array.from(name, (value) => `${character(value)}${continuation}*`).join("")})`;
};

/**
 * Matches source that could spell one of the names, including through escapes, so Rules can
 * skip files that cannot contain the callee or key they start from.
 */
export function namePattern(names: readonly string[]): RegExp {
  return new RegExp(names.map(escapedNamePattern).join("|"));
}
