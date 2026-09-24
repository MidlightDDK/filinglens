import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

function call(path: string, init?: RequestInit) {
  const env = {
    ASSETS: { fetch: vi.fn(async () => new Response("<html></html>")) },
  } as unknown as Env;
  return {
    env,
    response: worker.fetch(
      new Request(`https://filinglens.test${path}`, init) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
    ),
  };
}

describe("worker", () => {
  it("GET /api/health returns JSON", async () => {
    const res = await call("/api/health").response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok", providers: [] });
  });

  it("rejects non-GET on /api/health", async () => {
    const res = await call("/api/health", { method: "POST" }).response;
    expect(res.status).toBe(405);
  });

  it("returns a JSON 404 for unknown /api routes", async () => {
    const { env, response } = call("/api/nope");
    const res = await response;
    expect(res.status).toBe(404);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("falls back to static assets outside /api", async () => {
    const { env, response } = call("/");
    await response;
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });
});
