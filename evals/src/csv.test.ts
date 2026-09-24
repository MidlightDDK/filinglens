import { describe, expect, it } from "vitest";
import { formatCsv, parseCsv } from "./csv.ts";

describe("csv", () => {
  it("round-trips quotes, delimiters, and newlines", () => {
    const rows = [
      { id: "a", text: 'He said "hi", then; left\nnext line' },
      { id: "b", text: "" },
    ];
    const csv = formatCsv(["id", "text"], rows);
    expect(csv.startsWith("﻿id,text\r\n")).toBe(true);
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("reads semicolon-delimited files and skips blank rows", () => {
    const csv =
      'id;decision;question\r\nx1;accept;"a;b"\r\n;;\r\nx2;reject;c\r\n';
    expect(parseCsv(csv)).toEqual([
      { id: "x1", decision: "accept", question: "a;b" },
      { id: "x2", decision: "reject", question: "c" },
    ]);
  });
});
