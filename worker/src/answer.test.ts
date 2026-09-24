import { PROMPT_VERSION } from "@filinglens/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, normalizeQuestion, remapMarkers } from "./cache";
import type { Env } from "./env";
import worker from "./index";
import { resetCold } from "./providers/chain";
import { signSession } from "./session";
import {
  CHUNK_IDS,
  makeCtx,
  makeEnv,
  openAiResponse,
  post,
  readEvents,
} from "./testing";

const body = {
  question: "What were Apple's net sales?",
  chunkIds: CHUNK_IDS,
  configId: "default",
};

async function ask(
  env: Env,
  payload: unknown = body,
  headers: Record<string, string> = {},
) {
  const { value } = await signSession("test-hmac");
  const { ctx, settle } = makeCtx();
  const res = await worker.fetch(
    post("/api/answer", payload, {
      cookie: `fl_session=${value}`,
      ...headers,
    }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  return { res, settle };
}

beforeEach(() => {
  resetCold();
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/answer", () => {
  it("requires a session", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      post("/api/answer", body) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ reason: "session" });
  });

  it("streams tokens then done, prompt built from asset chunks, and caches", async () => {
    const { env, kv } = makeEnv();
    const { res, settle } = await ask(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(res);
    await settle();
    expect(events.slice(0, 2)).toEqual([
      { event: "token", data: { text: "Sales " } },
      { event: "token", data: { text: "rose [1]." } },
    ]);
    expect(events[2]).toMatchObject({
      event: "done",
      data: {
        provider: "workersAi",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        promptVersion: PROMPT_VERSION,
        usage: { prompt_tokens: 90, completion_tokens: 10 },
        cached: false,
      },
    });

    const inputs = vi.mocked(env.AI.run).mock.calls[0]?.[1] as {
      messages: { content: string }[];
    };
    const user = inputs.messages[1]?.content ?? "";
    expect(user).toContain("[1] Apple (AAPL) | FY2025 10-K | Item 7");
    expect(user).toContain("Total net sales were $416,161 million in 2025.");
    expect(user).toContain("QUESTION: What were Apple's net sales?");

    const key = await cacheKey("default", body.question, CHUNK_IDS);
    expect(JSON.parse(kv.get(key) ?? "{}")).toMatchObject({
      answer: "Sales rose [1].",
      chunkIds: CHUNK_IDS,
      provider: "workersAi",
    });
  });

  it("serves a cache hit without calling providers, remapping markers", async () => {
    const { env } = makeEnv();
    const first = await ask(env);
    await readEvents(first.res);
    await first.settle();
    vi.mocked(env.AI.run).mockClear();

    const reordered = { ...body, chunkIds: [...CHUNK_IDS].reverse() };
    const { res } = await ask(env, {
      ...reordered,
      question: "  what were apple's NET sales ",
    });
    const events = await readEvents(res);
    expect(events[0]).toEqual({
      event: "token",
      data: { text: "Sales rose [2]." },
    });
    expect(events[1]).toMatchObject({ event: "done", data: { cached: true } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("honors X-Debug-Fail only with DEV_FLAGS=1, bypassing the cache", async () => {
    const { env: dev, kv } = makeEnv({ DEV_FLAGS: "1" });
    vi.stubGlobal("fetch", async () => openAiResponse(["Groq [1]."]));
    await readEvents((await ask(dev)).res); // cached from Workers AI
    const forced = await ask(dev, body, { "x-debug-fail": "workersAi" });
    let events = await readEvents(forced.res);
    await forced.settle();
    expect(events.at(-1)).toMatchObject({
      data: { provider: "groq", cached: false },
    });
    expect([...kv.values()].map((v) => JSON.parse(v).provider)).toEqual([
      "workersAi",
    ]);

    const prod = makeEnv().env;
    events = await readEvents(
      (await ask(prod, body, { "x-debug-fail": "workersAi" })).res,
    );
    expect(events.at(-1)).toMatchObject({ data: { provider: "workersAi" } });
  });

  it("returns 503 quota when every provider fails", async () => {
    const { env } = makeEnv({ DEV_FLAGS: "1" });
    const { res } = await ask(env, body, {
      "x-debug-fail": "workersAi,groq,gemini",
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ reason: "quota" });
  });

  it("sends an error event when the provider fails mid-stream", async () => {
    const { env, kv } = makeEnv();
    let pulls = 0;
    env.AI.run = async () =>
      new ReadableStream({
        pull(c) {
          if (pulls++ === 0) {
            c.enqueue(new TextEncoder().encode('data: {"response":"Par"}\n\n'));
          } else {
            c.error(new Error("connection reset"));
          }
        },
      });
    const { res, settle } = await ask(env);
    const events = await readEvents(res);
    await settle();
    expect(events).toEqual([
      { event: "token", data: { text: "Par" } },
      { event: "error", data: { reason: "provider" } },
    ]);
    expect(kv.size).toBe(0);
  });

  it("rejects unknown chunks, configs, and oversize inputs", async () => {
    const { env } = makeEnv();
    const bad = [
      { ...body, chunkIds: ["AAPL-FY2025-structure-99999"] },
      { ...body, configId: "nope" },
      { ...body, question: "x".repeat(501) },
      { ...body, chunkIds: Array.from({ length: 11 }, (_, i) => `c${i}`) },
      { ...body, chunkIds: [CHUNK_IDS[0], CHUNK_IDS[0]] },
      { ...body, chunkIds: ["../secrets"] },
    ];
    for (const payload of bad) {
      expect((await ask(env, payload)).res.status).toBe(400);
    }
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rate-limits on RL_ANSWER", async () => {
    const { env } = makeEnv();
    env.RL_ANSWER.limit = async () => ({ success: false });
    const { res } = await ask(env);
    expect(res.status).toBe(429);
  });
});

describe("cache helpers", () => {
  it("normalizes questions", () => {
    expect(normalizeQuestion("  What   were SALES?? ")).toBe("what were sales");
  });

  it("keys ignore chunk order but not the question or config", async () => {
    const a = await cacheKey("default", "q", ["b", "a"]);
    expect(await cacheKey("default", "Q?", ["a", "b"])).toBe(a);
    expect(await cacheKey("fixed", "q", ["a", "b"])).not.toBe(a);
    expect(await cacheKey("default", "q2", ["a", "b"])).not.toBe(a);
  });

  it("remaps markers, including comma lists", () => {
    expect(remapMarkers("A [1][2]. B [1, 2].", ["x", "y"], ["y", "x"])).toBe(
      "A [2][1]. B [2, 1].",
    );
  });
});
