import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, openAiResponse, sseStream } from "../testing";
import {
  AllProvidersFailed,
  isCold,
  PROVIDERS,
  resetCold,
  startChain,
} from "./chain";
import { gemini, groq } from "./openaiCompat";
import { COLD_MS, GEMINI, GROQ, WORKERS_AI } from "./providers.config";
import type { ProviderEvent } from "./types";
import { workersAi } from "./workersAi";

const messages = [{ role: "user" as const, content: "q" }];

async function drain(it: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

/** fetch mock routing Groq and Gemini URLs to per-provider handlers. */
function stubFetch(handlers: {
  groq?: () => Response | Promise<Response>;
  gemini?: () => Response | Promise<Response>;
}) {
  const mock = vi.fn(async (url: string) => {
    const h = url === GROQ.url ? handlers.groq : handlers.gemini;
    if (!h) throw new Error(`unexpected fetch ${url}`);
    return h();
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => resetCold());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("adapters normalize their streams", () => {
  it("Workers AI: {response} chunks, usage from the last chunk", async () => {
    const { env } = makeEnv();
    const events = await drain(
      workersAi.stream(messages, env, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "token", text: "Sales " },
      { type: "token", text: "rose [1]." },
      { type: "done", usage: { prompt_tokens: 90, completion_tokens: 10 } },
    ]);
    expect(env.AI.run).toHaveBeenCalledWith(WORKERS_AI.model, {
      messages,
      stream: true,
      max_tokens: 400,
      temperature: 0,
    });
  });

  it("Workers AI: prefers exact deltas over the lossy numeric response field", async () => {
    const { env } = makeEnv();
    const both = (content: string, response: unknown) =>
      JSON.stringify({ choices: [{ delta: { content } }], response });
    env.AI.run = async () =>
      sseStream(
        both("in fiscal", "in fiscal"),
        both(" 2025", 2025),
        both("0", 0),
        "[DONE]",
      );
    const events = await drain(
      workersAi.stream(messages, env, new AbortController().signal),
    );
    expect(events.filter((e) => e.type === "token").map((e) => e.text)).toEqual(
      ["in fiscal", " 2025", "0"],
    );
  });

  it("Workers AI: OpenAI-style deltas", async () => {
    const { env } = makeEnv();
    env.AI.run = async () =>
      sseStream(
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
        "[DONE]",
      );
    expect(
      await drain(
        workersAi.stream(messages, env, new AbortController().signal),
      ),
    ).toEqual([
      { type: "token", text: "Hi" },
      { type: "done", usage: null },
    ]);
  });

  it("Groq: skips empty deltas, reads usage, sends the request shape", async () => {
    const { env } = makeEnv();
    const fetchMock = stubFetch({
      groq: () => openAiResponse(["", "A", "B"]),
    });
    expect(
      await drain(groq.stream(messages, env, new AbortController().signal)),
    ).toEqual([
      { type: "token", text: "A" },
      { type: "token", text: "B" },
      { type: "done", usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer test-groq",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: GROQ.model,
      stream: true,
      temperature: 0,
      messages,
    });
  });

  it("Groq: usage under x_groq", async () => {
    const { env } = makeEnv();
    stubFetch({
      groq: () =>
        new Response(
          sseStream(
            JSON.stringify({ choices: [{ delta: { content: "A" } }] }),
            JSON.stringify({
              choices: [],
              x_groq: { usage: { prompt_tokens: 5, completion_tokens: 1 } },
            }),
            "[DONE]",
          ),
        ),
    });
    const events = await drain(
      groq.stream(messages, env, new AbortController().signal),
    );
    expect(events.at(-1)).toEqual({
      type: "done",
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
  });

  it("Gemini: bearer key and OpenAI-compatible stream", async () => {
    const { env } = makeEnv();
    const fetchMock = stubFetch({ gemini: () => openAiResponse(["G"]) });
    expect(
      await drain(gemini.stream(messages, env, new AbortController().signal)),
    ).toEqual([
      { type: "token", text: "G" },
      { type: "done", usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(GEMINI.url);
  });

  it("throws the HTTP status as a ProviderError", async () => {
    const { env } = makeEnv();
    stubFetch({ groq: () => new Response("slow down", { status: 429 }) });
    await expect(
      drain(groq.stream(messages, env, new AbortController().signal)),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe("startChain", () => {
  it("uses Workers AI first", async () => {
    const { env } = makeEnv();
    const fetchMock = stubFetch({});
    const s = await startChain(messages, env);
    expect(s.provider.id).toBe("workersAi");
    expect(s.first).toBe("Sales ");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forced failure of each provider falls through in order", async () => {
    const { env } = makeEnv();
    stubFetch({
      groq: () => openAiResponse(["from groq"]),
      gemini: () => openAiResponse(["from gemini"]),
    });
    const run = (fail: string[]) =>
      startChain(messages, env, { forceFail: new Set(fail) });

    expect((await run(["workersAi"])).provider.id).toBe("groq");
    const g = await run(["workersAi", "groq"]);
    expect(g.provider.id).toBe("gemini");
    expect(g.first).toBe("from gemini");
    expect(g.attempts.map((a) => a.outcome)).toEqual([
      "forced",
      "forced",
      "ok",
    ]);
    expect((await run(["groq"])).provider.id).toBe("workersAi");

    await expect(run(["workersAi", "groq", "gemini"])).rejects.toBeInstanceOf(
      AllProvidersFailed,
    );
    // Forced failures never mark a provider cold.
    expect(isCold("workersAi")).toBe(false);
  });

  it("falls through on a binding error and on 429/5xx, marking them cold", async () => {
    const { env } = makeEnv();
    env.AI.run = async () => {
      throw new Error("3036: daily neuron limit");
    };
    stubFetch({
      groq: () => new Response("", { status: 429 }),
      gemini: () => openAiResponse(["ok"]),
    });
    const s = await startChain(messages, env);
    expect(s.provider.id).toBe("gemini");
    expect(s.attempts).toEqual([
      { provider: "workersAi", outcome: "error", status: 503 },
      { provider: "groq", outcome: "error", status: 429 },
      { provider: "gemini", outcome: "ok" },
    ]);
    expect(isCold("workersAi")).toBe(true);
    expect(isCold("groq")).toBe(true);

    // Cold providers are skipped without being called until COLD_MS passes.
    const run = vi.fn(env.AI.run);
    env.AI.run = run;
    const again = await startChain(messages, env);
    expect(again.attempts.map((a) => a.outcome)).toEqual([
      "cold",
      "cold",
      "ok",
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(isCold("groq", Date.now() + COLD_MS + 1)).toBe(false);
  });

  it("does not mark a provider cold on a 400", async () => {
    const { env } = makeEnv({ AI: undefined as never });
    stubFetch({
      groq: () => new Response("bad", { status: 400 }),
      gemini: () => openAiResponse(["ok"]),
    });
    const s = await startChain(messages, env);
    expect(s.attempts.map((a) => a.outcome)).toEqual([
      "unconfigured",
      "error",
      "ok",
    ]);
    expect(isCold("groq")).toBe(false);
  });

  it("falls through when no first token arrives in time", async () => {
    const { env } = makeEnv();
    let aborted = false;
    env.AI.run = () => new Promise(() => {}); // never answers
    stubFetch({
      groq: () => openAiResponse(["late but fine"]),
    });
    const hang = {
      ...PROVIDERS.workersAi,
      async *stream(_m: unknown, _e: unknown, signal: AbortSignal) {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise(() => {});
        yield { type: "token" as const, text: "never" };
      },
    };
    const s = await startChain(messages, env, {
      providers: [hang, PROVIDERS.groq],
      firstTokenMs: 20,
    });
    expect(s.provider.id).toBe("groq");
    expect(s.attempts[0]).toEqual({
      provider: "workersAi",
      outcome: "timeout",
    });
    expect(aborted).toBe(true);
    expect(isCold("workersAi")).toBe(true);
  });

  it("treats an empty stream as a failure", async () => {
    const { env } = makeEnv();
    env.AI.run = async () => sseStream("[DONE]");
    stubFetch({ groq: () => openAiResponse(["A"]) });
    const s = await startChain(messages, env);
    expect(s.provider.id).toBe("groq");
    expect(s.attempts[0]).toMatchObject({ provider: "workersAi", status: 502 });
  });
});
