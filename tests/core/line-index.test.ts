import { describe, expect, it } from "vite-plus/test";
import { createHelpers } from "../../src/core/internal/doctor-helpers.js";
import { lineColumnAt } from "../../src/core/internal/line-index.js";

function sliceSplitReference(source: string, offset: number) {
  const lines = source.slice(0, offset).split(/\r?\n/);
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

const sources = {
  lf: "const a = 1;\nconst b = 2;\n\nexport { a, b };\n",
  crlf: "const a = 1;\r\nconst b = 2;\r\n\r\nexport { a, b };\r\n",
  loneCr: "one\rtwo\r\nthree\r\rfour\nfive\r",
  mixed: "\n\r\n\r\r\n\nend",
  empty: "",
};

describe("lineColumnAt", () => {
  it.each(Object.entries(sources))("matches slice/split for every offset in %s", (_, source) => {
    for (let offset = -source.length - 2; offset <= source.length + 2; offset++) {
      expect(lineColumnAt(source, offset), `offset ${offset}`).toEqual(
        sliceSplitReference(source, offset),
      );
    }
  });

  it("treats offset 0 as the first column of the first line", () => {
    expect(lineColumnAt(sources.lf, 0)).toEqual({ line: 1, column: 1 });
  });

  it("starts a new line right after LF and CRLF", () => {
    expect(lineColumnAt(sources.lf, 13)).toEqual({ line: 2, column: 1 });
    expect(lineColumnAt(sources.crlf, 14)).toEqual({ line: 2, column: 1 });
  });

  it("keeps the CR of a CRLF on the previous line", () => {
    expect(lineColumnAt(sources.crlf, 13)).toEqual({ line: 1, column: 14 });
  });

  it("does not treat a lone CR as a line break", () => {
    expect(lineColumnAt(sources.loneCr, 4)).toEqual({ line: 1, column: 5 });
    expect(lineColumnAt("a\rb", 3)).toEqual({ line: 1, column: 4 });
  });

  it("places the end offset after a trailing newline on a new line", () => {
    expect(lineColumnAt(sources.lf, sources.lf.length)).toEqual({ line: 5, column: 1 });
    expect(lineColumnAt(sources.crlf, sources.crlf.length)).toEqual({ line: 5, column: 1 });
    expect(lineColumnAt("abc", 3)).toEqual({ line: 1, column: 4 });
  });

  it("follows slice semantics for fractional, NaN, and infinite offsets", () => {
    for (const offset of [1.7, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(lineColumnAt(sources.lf, offset)).toEqual(sliceSplitReference(sources.lf, offset));
    }
  });

  it("stays correct when alternating between many sources", () => {
    const many = Array.from({ length: 40 }, (_, index) => "x\n".repeat(index + 1));
    for (let round = 0; round < 2; round++) {
      for (const source of many) {
        expect(lineColumnAt(source, source.length)).toEqual(
          sliceSplitReference(source, source.length),
        );
      }
    }
  });
});

describe("rangeFromOffsets", () => {
  it("keeps start and end while computing line and column from the start offset", () => {
    const helpers = createHelpers();
    expect(helpers.rangeFromOffsets("file.ts", sources.crlf, 14, 19)).toEqual({
      start: 14,
      end: 19,
      line: 2,
      column: 1,
    });
    expect(helpers.rangeFromOffsets("file.ts", sources.lf, 5)).toEqual({
      start: 5,
      end: 5,
      line: 1,
      column: 6,
    });
  });
});
