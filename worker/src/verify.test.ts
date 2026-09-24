import { JUDGE_VERSION } from "@filinglens/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  workersAiStream,
} from "./testing";

const body = {
  question: "What were Apple's net sales?",
  answer:
    "Net sales were $416,161 million [1]. Services grew because of iPhone [2]. Apple is big.",
  chunkIds: CHUNK_IDS,
  configId: "default",
};

const verdicts = JSON.stringify({
  verdicts: [
    { claim: 1, supported: true, reason: "stated in [1]" },
    { claim: 2, supported: false, reason: "source cites advertising" },
  ],
});

async function verify(env: Env, payload: unknown = body, session = true) {
  const { value } = await signSession("test-hmac");
  const { ctx } = makeCtx();
  return worker.fetch(
    post(
      "/api/verify",
      payload,
      session ? { cookie: `fl_session=${value}` } : {},
    ) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetCold();
  fetchMock = vi.fn(async () => openAiResponse([verdicts]));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/verify", () => {
  it("requires a session and a same-origin request", async () => {
    const { env } = makeEnv();
    expect((await verify(env, body, false)).status).toBe(401);
    const { ctx } = makeCtx();
    const cross = post("/api/verify", body, { origin: "https://evil.test" });
    const res = await worker.fetch(
      cross as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("judges cited sentences with the Groq judge model, on server-loaded sources", async () => {
    const { env } = makeEnv();
    const res = await verify(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      verdicts: [
        {
          plain: "Net sales were $416,161 million.",
          supported: true,
          reason: "stated in [1]",
        },
        {
          plain: "Services grew because of iPhone.",
          supported: false,
          reason: "source cites advertising",
        },
      ],
      provider: "groqJudge",
      model: "qwen/qwen3.8-27b",
      judgeVersion: JUDGE_VERSION,
      cached: false,
    });
    const sent = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(sent.model).toBe("qwen/qwen3.8-27b");
    const user = sent.messages[1].content as string;
    expect(user).toContain("Total net sales were $416,161 million in 2025.");
    expect(user).toContain(
      "CLAIM 2 (cites [2]): Services grew because of iPhone.",
    );
    expect(user).not.toContain("Apple is big");
  });

  it("serves a repeat from the cache", async () => {
    const { env } = makeEnv();
    await verify(env);
    const res = await verify(env);
    expect(await res.json()).toMatchObject({ cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Workers AI when Groq fails", async () => {
    fetchMock.mockImplementation(
      async () => new Response("quota", { status: 429 }),
    );
    const { env } = makeEnv();
    vi.mocked(env.AI.run).mockImplementation(async () =>
      workersAiStream([verdicts]),
    );
    const res = await verify(env);
    expect(await res.json()).toMatchObject({
      provider: "workersAi",
      verdicts: [{ supported: true }, { supported: false }],
    });
  });

  it("returns no verdicts without calling a model when nothing is cited", async () => {
    const { env } = makeEnv();
    const res = await verify(env, { ...body, answer: "Apple is big." });
    expect(await res.json()).toMatchObject({ verdicts: [], provider: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an unparsable judge reply as a provider error", async () => {
    fetchMock.mockImplementation(async () => openAiResponse(["Looks fine."]));
    const { env, kv } = makeEnv();
    const res = await verify(env);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ reason: "provider" });
    expect(kv.size).toBe(0);
  });

  it("rejects an oversized answer", async () => {
    const { env } = makeEnv();
    const res = await verify(env, { ...body, answer: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("returns 503 quota when every judge provider fails", async () => {
    fetchMock.mockImplementation(
      async () => new Response("quota", { status: 429 }),
    );
    const { env } = makeEnv();
    vi.mocked(env.AI.run).mockRejectedValue(new Error("3036: neuron limit"));
    const res = await verify(env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ reason: "quota" });
  });
});
