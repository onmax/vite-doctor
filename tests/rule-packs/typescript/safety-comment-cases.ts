export const cases: [string, string, number][] = [
  ["empty multiline block", "/* SAFETY:\n *\n */ const value = input as User", 1],
  [
    "multiline explanation",
    "/* SAFETY:\n * Schema validated this value.\n */ const value = input as User",
    0,
  ],
  [
    "continued line explanation",
    "// SAFETY:\n// Schema validated this value.\nconst value = input as User",
    0,
  ],
  ["empty line group", "// SAFETY:\n//   \nconst value = input as User", 1],
  ["blank line before declaration", "// SAFETY: validated\n\nconst value = input as User", 1],
  ["blank CRLF line", "// SAFETY: validated\r\n\r\nconst value = input as User", 1],
  ["separated explanation", "// SAFETY:\n\n// validated\nconst value = input as User", 1],
  ["for initializer", "// SAFETY: validated\nfor (const value = input as User; ;) {}", 0],
  [
    "for of initializer",
    "// SAFETY: validated\nfor (const { value = input as User } of items) {}",
    0,
  ],
  ["for in initializer", "// SAFETY: validated\nfor (const value in input as User) {}", 0],
  ["loop body unrelated", "// SAFETY: validated\nfor (;;) { const value = input as User }", 1],
  ["for body condition", "// SAFETY: validated\nfor (;;) { if (input as User) {} }", 1],
  [
    "for of body condition",
    "// SAFETY: validated\nfor (const item of items) { if (input as User) {} }",
    1,
  ],
  [
    "for in body condition",
    "// SAFETY: validated\nfor (const key in items) { if (input as User) {} }",
    1,
  ],
  ["unbraced loop body", "// SAFETY: validated\nfor (;;) if (input as User) {}", 1],
  ["while body condition", "// SAFETY: validated\nwhile (ready) { if (input as User) {} }", 1],
  [
    "do while body condition",
    "// SAFETY: validated\ndo { if (input as User) {} } while (ready)",
    1,
  ],
  ["loop header condition", "// SAFETY: validated\nfor (; input as User;) {}", 0],
  ["loop body own comment", "for (;;) {\n// SAFETY: validated\nif (input as User) {} }", 0],
  ["missing", "const value = input as User", 1],
  ["empty marker", "// SAFETY:\nconst value = input as User", 1],
  ["empty block marker", "/* SAFETY: */ const value = input as User", 1],
  ["string marker", 'const message = "SAFETY: validated"; const value = input as User', 1],
  ["template marker", "const message = `SAFETY: validated`; const value = input as User", 1],
  ["unrelated statement", "// SAFETY: validated\nconst other = 1; const value = input as User", 1],
  ["trailing marker", "const value = input as User // SAFETY: validated", 1],
  ["identifier prefix", "// UNSAFETY: validated\nconst value = input as User", 1],
  [
    "multiline declaration",
    "// SAFETY: schema validated this input.\nconst value = (\n  (\n    input as User\n  )\n)",
    0,
  ],
  ["inline assertion", "const value = /* SAFETY: schema validated this input. */ input as User", 0],
  [
    "export owner",
    "// SAFETY: schema validated this input.\nexport const value = input as User",
    0,
  ],
  [
    "return owner",
    "function get() {\n// SAFETY: schema validated this input.\nreturn input as User\n}",
    0,
  ],
  [
    "later statement",
    "// SAFETY: schema validated this input.\nconst first = input as User; const second = input as User",
    1,
  ],
  ["const assertion", "const value = { id: 1 } as const", 0],
  [
    "comment group",
    "// SAFETY: schema validated this input.\n// Preserve the brand.\nconst value = input as User",
    0,
  ],
  ["CRLF", "// SAFETY: schema validated this input.\r\nconst value = input as User", 0],
  [
    "ternary branch",
    "const value = ready\n  // SAFETY: schema validated this input.\n  ? input as User\n  : undefined",
    0,
  ],
  [
    "ternary branch covers only its line",
    "const value = ready\n  // SAFETY: schema validated this input.\n  ? input as User\n  : other as User",
    1,
  ],
  [
    "ternary branch after a blank line",
    "const value = ready\n  // SAFETY: schema validated this input.\n\n  ? input as User\n  : undefined",
    1,
  ],
  [
    "logical and branch",
    "const value = ready\n  // SAFETY: schema validated this input.\n  && input as User",
    0,
  ],
  [
    "logical or branch",
    "const value = fallback\n  // SAFETY: schema validated this input.\n  || input as User",
    0,
  ],
  [
    "single-statement if body",
    "function get() {\n// SAFETY: schema validated this input.\nif (ready) return input as User\n}",
    0,
  ],
  [
    "single-statement if body on the next line",
    "function get() {\n// SAFETY: schema validated this input.\nif (ready)\n  return input as User\n}",
    0,
  ],
  [
    "single-statement else body",
    "function get() {\nif (ready) return undefined\n// SAFETY: schema validated this input.\nelse return input as User\n}",
    0,
  ],
  [
    "else if body",
    "function get() {\nif (ready) return undefined\n// SAFETY: schema validated this input.\nelse if (input) return input as User\n}",
    0,
  ],
  [
    "braced if body",
    "function get() {\n// SAFETY: schema validated this input.\nif (ready) {\n  return input as User\n}\n}",
    1,
  ],
  [
    "leading semicolon",
    "const timer = start()\n// SAFETY: Node timers expose unref.\n;(timer as Timer).unref()",
    0,
  ],
  [
    "continued call arguments",
    "run(() => {\n  start()\n// SAFETY: the registry stored this input.\n}, input as never)",
    0,
  ],
  [
    "member chain line",
    "const values = keys\n  // SAFETY: the route is a record.\n  .map((key) => (route as Record<string, unknown>)[key])",
    0,
  ],
  [
    "switch case line",
    "switch (kind) {\n// SAFETY: only the driver field is read.\ndefault: throw fail((store as Store).driver)\n}",
    0,
  ],
  [
    "object property line",
    "const handlers = {\n// SAFETY: toggle events come from this details element.\nonToggle: (event: Event) => { open = (event.target as HTMLDetailsElement).open },\n}",
    0,
  ],
  [
    "line above an unrelated case",
    "switch (kind) {\ncase 1: break\n// SAFETY: only the driver field is read.\ncase 2: stop(); throw fail((store as Store).driver)\n}",
    1,
  ],
  ["semicolon after code", "// SAFETY: validated\nstart(); const value = input as User", 1],
];

export const attachmentRegressions: [string, string, number][] = [
  [
    "trailing declaration comment",
    "const other = 1; // SAFETY: about other.\nconst read = () => { return input as User; }",
    1,
  ],
  [
    "trailing chain comment",
    "const values = keys // SAFETY: about keys.\n.map(() => input as User)",
    1,
  ],
  [
    "multiline else",
    "function read() { if (ready) return;\n// SAFETY: schema validated input.\nelse\n return input as User; }",
    0,
  ],
  [
    "blank line after else",
    "function read() { if (ready) return;\n// SAFETY: schema validated input.\nelse\n\n return input as User; }",
    1,
  ],
  [
    "blank line before else",
    "function read() { if (ready) return;\n// SAFETY: schema validated input.\n\nelse\n return input as User; }",
    1,
  ],
];
cases.push(...attachmentRegressions);
