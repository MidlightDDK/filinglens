import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { hasSession, SESSION_TTL_S, signSession } from "./session";
import { makeCtx, makeEnv, ORIGIN, post } from "./testing";

const call = (request: Request, env = makeEnv().env) =>
  worker.fetch(
    request as Request<unknown, IncomingRequestCfProperties>,
    env,
    makeCtx().ctx,
  );

const withCookie = (value: string) =>
  new Request(`${ORIGIN}/api/answer`, {
    headers: { cookie: `other=1; fl_session=${value}` },
  });

afterEach(() => vi.unstubAllGlobals());

describe("session cookie", () => {
  it("accepts a fresh signature and rejects tampered or expired ones", async () => {
    const { env } = makeEnv();
    const now = Date.UTC(2026, 8, 24);
    const { value, expiresAt } = await signSession("test-hmac", now);
    expect(expiresAt).toBe(now + SESSION_TTL_S * 1000);
    expect(await hasSession(withCookie(value), env, now)).toBe(true);

    const [exp, sig] = value.split(".");
    const later = `${Number(exp) + 60}.${sig}`;
    expect(await hasSession(withCookie(later), env, now)).toBe(false);
    expect(await hasSession(withCookie(`${exp}.AAAA`), env, now)).toBe(false);
    expect(await hasSession(withCookie("garbage"), env, now)).toBe(false);
    expect(await hasSession(withCookie(value), env, expiresAt)).toBe(false);

    const other = makeEnv({ SESSION_HMAC_SECRET: "rotated" }).env;
    expect(await hasSession(withCookie(value), other, now)).toBe(false);
  });
});

describe("POST /api/session", () => {
  it("verifies Turnstile and sets a strict HttpOnly cookie", async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call(post("/api/session", { turnstileToken: "tok" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^fl_session=\d+\.[\w-]+;/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api"]) {
      expect(cookie).toContain(attr);
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("challenges.cloudflare.com/turnstile/v0/siteverify");
    const form = init.body as FormData;
    expect(form.get("response")).toBe("tok");
    expect(form.get("secret")).toBe("test-turnstile");
    expect(form.get("remoteip")).toBe("203.0.113.7");
  });

  it("returns 403 when Turnstile rejects the token or is unreachable", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: false }));
    let res = await call(post("/api/session", { turnstileToken: "bad" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ reason: "turnstile" });

    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    res = await call(post("/api/session", { turnstileToken: "tok" }));
    expect(res.status).toBe(403);
  });

  it("returns 503 when secrets are not configured", async () => {
    const { env } = makeEnv({ TURNSTILE_SECRET_KEY: undefined });
    const res = await call(post("/api/session", { turnstileToken: "t" }), env);
    expect(res.status).toBe(503);
  });
});
