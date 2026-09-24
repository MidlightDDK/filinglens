// Test doubles for the Worker's bindings (imported only by *.test.ts).
import { parseSSE } from "@filinglens/core";
import { vi } from "vitest";
import type { Env } from "./env";

export const ORIGIN = "https://filinglens.test";

export const DOCS = {
  "AAPL-FY2025": {
    company: "Apple",
    ticker: "AAPL",
    aliases: [],
    fy: 2025,
    filing_date: "2025-10-31",
    url: "https://www.sec.gov/aapl",
  },
};

export const CHUNKS = {
  "AAPL-FY2025-structure-00001": {
    text: "Total net sales were $416,161 million in 2025.",
    doc_id: "AAPL-FY2025",
    item: "7",
    heading_path: ["Item 7 MD&A"],
    char_start: 0,
    char_end: 46,
  },
  "AAPL-FY2025-structure-00002": {
    text: "Services net sales increased due to advertising.",
    doc_id: "AAPL-FY2025",
    item: "7",
    heading_path: ["Item 7 MD&A"],
    char_start: 46,
    char_end: 94,
  },
};
export const CHUNK_IDS = Object.keys(CHUNKS);

export function sseStream(...events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${e}\n\n`));
      c.close();
    },
  });
}

/** An OpenAI-compatible streaming response with the given content deltas. */
export function openAiResponse(parts: string[], usage = true): Response {
  const events = parts.map((content) =>
    JSON.stringify({ choices: [{ delta: { content } }] }),
  );
  if (usage) {
    events.push(
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  }
  events.push("[DONE]");
  return new Response(sseStream(...events), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** A Workers AI stream in the `{response}` format. */
export function workersAiStream(parts: string[]): ReadableStream<Uint8Array> {
  return sseStream(
    ...parts.map((response) => JSON.stringify({ response })),
    JSON.stringify({
      response: "",
      usage: { prompt_tokens: 90, completion_tokens: 10 },
    }),
    "[DONE]",
  );
}

export function makeEnv(overrides: Partial<Env> = {}) {
  const kv = new Map<string, string>();
  const env = {
    ASSETS: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input),
        ).pathname;
        if (path === "/index/structure/docs.json") return Response.json(DOCS);
        if (path.startsWith("/index/structure/chunks/")) {
          return Response.json(CHUNKS);
        }
        if (path.startsWith("/index/")) {
          return new Response("not found", { status: 404 });
        }
        return new Response("<html></html>");
      }),
    },
    AI: { run: vi.fn(async () => workersAiStream(["Sales ", "rose [1]."])) },
    ANSWER_CACHE: {
      get: vi.fn(async (key: string) => {
        const v = kv.get(key);
        return v === undefined ? null : JSON.parse(v);
      }),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      }),
    },
    RL_ANSWER: { limit: vi.fn(async () => ({ success: true })) },
    RL_OTHER: { limit: vi.fn(async () => ({ success: true })) },
    GROQ_API_KEY: "test-groq",
    GEMINI_API_KEY: "test-gemini",
    TURNSTILE_SECRET_KEY: "test-turnstile",
    SESSION_HMAC_SECRET: "test-hmac",
    ...overrides,
  } as unknown as Env;
  return { env, kv };
}

export function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

export function post(path: string, body: unknown, headers: HeadersInit = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function readEvents(res: Response) {
  const out: { event: string; data: unknown }[] = [];
  if (!res.body) return out;
  for await (const ev of parseSSE(res.body)) {
    out.push({ event: ev.event, data: JSON.parse(ev.data) });
  }
  return out;
}
