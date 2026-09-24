/** One server-sent event. `event` defaults to "message". */
export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Parses a `text/event-stream` body (the WHATWG format: `event:` and `data:`
 * fields, a blank line dispatches, `:` starts a comment). Used for upstream
 * LLM streams in the Worker and for the Worker's own stream in the browser.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  let finished = false;
  const dispatch = (): SSEEvent | null => {
    const ev = data.length
      ? { event: event || "message", data: data.join("\n") }
      : null;
    event = "";
    data = [];
    return ev;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          const ev = dispatch();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
      }
    }
    // Be lenient with streams that end without a final blank line.
    if (buf.trim().startsWith("data:")) data.push(buf.trim().slice(5).trim());
    const ev = dispatch();
    if (ev) yield ev;
  } finally {
    // A consumer that stops early (or a read that failed) cancels upstream.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Serializes one event in the format `parseSSE` reads. */
export function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
