// Minimal RFC 4180 CSV for the review files. Written with a UTF-8 BOM and CRLF
// so Excel opens them correctly; parsing accepts "," or ";" (Excel in locales
// with a decimal comma saves with ";").

export type Row = Record<string, string>;

const BOM = "﻿";

function cell(value: string): string {
  return /[",;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatCsv(columns: readonly string[], rows: Row[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(row[c] ?? "")).join(","));
  }
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

function records(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      out.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    out.push(record);
  }
  return out;
}

export function parseCsv(text: string): Row[] {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const header = body.slice(0, body.search(/\r?\n|$/));
  const delimiter =
    (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const [columns, ...rest] = records(body, delimiter);
  if (!columns) return [];
  return rest
    .filter((r) => r.some((v) => v.trim() !== ""))
    .map((r) =>
      Object.fromEntries(columns.map((c, i) => [c.trim(), r[i] ?? ""])),
    );
}
