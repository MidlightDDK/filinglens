import { beforeEach, describe, expect, it } from "vitest";
import worker from "./index";
import { resetCold } from "./providers/chain";
import { makeCtx, makeEnv, ORIGIN, post } from "./testing";

const call = (request: Request, env = makeEnv().env) =>
  worker.fetch(
    request as Request<unknown, IncomingRequestCfProperties>,
    env,
    makeCtx().ctx,
  );

beforeEach(() => resetCold());

describe("worker routing", () => {
  it("GET /api/health lists providers without secrets", async () => {
    const res = await call(new Request(`${ORIGIN}/api/health`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { providers: { id: string }[] };
    expect(body.providers.map((p) => p.id)).toEqual([
      "workersAi",
      "groq",
      "gemini",
    ]);
    expect(JSON.stringify(body)).not.toContain("test-groq");
  });

  it("reports unconfigured providers in health", async () => {
    const { env } = makeEnv({ GEMINI_API_KEY: undefined });
    const res = await call(new Request(`${ORIGIN}/api/health`), env);
    const body = (await res.json()) as {
      providers: { id: string; configured: boolean }[];
    };
    expect(body.providers.find((p) => p.id === "gemini")?.configured).toBe(
      false,
    );
  });

  it("rejects non-GET on /api/health", async () => {
    const res = await call(post("/api/health", {}));
    expect(res.status).toBe(405);
  });

  it("returns a JSON 404 for unknown /api routes", async () => {
    const { env } = makeEnv();
    const res = await call(new Request(`${ORIGIN}/api/nope`), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ reason: "not_found" });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("falls back to static assets outside /api", async () => {
    const { env } = makeEnv();
    await call(new Request(`${ORIGIN}/`), env);
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin and missing-Origin POSTs", async () => {
    for (const origin of ["https://evil.test", ""]) {
      const req = post("/api/session", { turnstileToken: "t" }, { origin });
      if (!origin) req.headers.delete("origin");
      const res = await call(req);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ reason: "origin" });
    }
  });

  it("rejects bodies over 16 KB and invalid JSON", async () => {
    const big = JSON.stringify({ turnstileToken: "x".repeat(17_000) });
    expect((await call(post("/api/session", big))).status).toBe(413);
    expect((await call(post("/api/session", "{nope"))).status).toBe(400);
    expect((await call(post("/api/session", { other: 1 }))).status).toBe(400);
  });

  it("returns 429 when the rate limiter says no", async () => {
    const { env } = makeEnv();
    env.RL_OTHER.limit = async () => ({ success: false });
    const res = await call(new Request(`${ORIGIN}/api/health`), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ reason: "rate_limit" });
    expect(res.headers.get("retry-after")).toBe("60");
  });
});
