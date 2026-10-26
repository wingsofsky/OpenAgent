import { describe, expect, it } from "vitest";
import { detectEol, withEol } from "../packages/protocol/src/eol.ts";

describe("line-ending kernel", () => {
  it("detectEol: CRLF only when there are more CRLF than bare LF; no line break = LF", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("single line")).toBe("\n");
    expect(detectEol("")).toBe("\n");
    expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("a\r\nb\nc\n")).toBe("\n");
  });

  it("withEol: unifies line breaks, leaves a lone \\r alone", () => {
    expect(withEol("a\nb\r\nc", "\r\n")).toBe("a\r\nb\r\nc");
    expect(withEol("a\nb\r\nc", "\n")).toBe("a\nb\nc");
    expect(withEol("a\rb", "\r\n")).toBe("a\rb");
  });
});
