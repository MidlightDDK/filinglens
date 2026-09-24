import { describe, expect, it } from "vitest";
import { formatSSE, parseSSE } from "./sse.ts";

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const ev of parseSSE(body)) out.push(ev);
  return out;
}

describe("parseSSE", () => {
  it("parses events split across chunks, CRLF, comments, and multi-line data", async () => {
    const events = await collect(
      streamOf(
        ": keep-alive\r\n\r\nevent: tok",
        'en\r\ndata: {"a":1}\r\n\r\ndata: x\ndata: y\n\n',
        "data:[DONE]\n\n",
      ),
    );
    expect(events).toEqual([
      { event: "token", data: '{"a":1}' },
      { event: "message", data: "x\ny" },
      { event: "message", data: "[DONE]" },
    ]);
  });

  it("dispatches a final event without a trailing blank line", async () => {
    expect(await collect(streamOf("data: 1\n\ndata: 2"))).toEqual([
      { event: "message", data: "1" },
      { event: "message", data: "2" },
    ]);
  });

  it("round-trips formatSSE", async () => {
    const text = formatSSE("done", { ok: true, s: "a\nb" });
    expect(await collect(streamOf(text))).toEqual([
      { event: "done", data: JSON.stringify({ ok: true, s: "a\nb" }) },
    ]);
  });

  it("cancels upstream when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode("data: 1\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _ of parseSSE(body)) break;
    expect(cancelled).toBe(true);
  });
});
