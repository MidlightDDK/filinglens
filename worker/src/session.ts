import * as z from "zod/mini";
import type { Env } from "./env";
import {
  clientIp,
  HttpError,
  json,
  rateLimit,
  readJson,
  requireMethod,
  requireSameOrigin,
} from "./http";

const COOKIE = "fl_session";
export const SESSION_TTL_S = 30 * 60;
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const enc = new TextEncoder();

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

/** Cookie value `{expiry seconds}.{HMAC-SHA256("v1.{expiry}")}`. */
export async function signSession(
  secret: string,
  now = Date.now(),
): Promise<{ value: string; expiresAt: number }> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_S;
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    enc.encode(`v1.${exp}`),
  );
  return { value: `${exp}.${b64url(sig)}`, expiresAt: exp * 1000 };
}

export async function hasSession(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  if (!env.SESSION_HMAC_SECRET) return false;
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie.match(/(?:^|;\s*)fl_session=([^;]+)/)?.[1];
  const [exp, sig] = value?.split(".") ?? [];
  const bytes = sig ? fromB64url(sig) : null;
  if (!exp || !bytes || !/^\d+$/.test(exp) || Number(exp) * 1000 <= now) {
    return false;
  }
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(env.SESSION_HMAC_SECRET),
    bytes,
    enc.encode(`v1.${exp}`),
  );
}

export async function verifyTurnstile(
  token: string,
  ip: string,
  secret: string,
): Promise<boolean> {
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  form.set("remoteip", ip);
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body: form });
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}

const Body = z.object({
  turnstileToken: z.string().check(z.minLength(1), z.maxLength(4096)),
});

/** POST /api/session {turnstileToken} → 30-minute HttpOnly session cookie. */
export async function handleSession(
  request: Request,
  env: Env,
): Promise<Response> {
  requireMethod(request, "POST");
  requireSameOrigin(request);
  const { turnstileToken } = await readJson(request, Body);
  await rateLimit(env.RL_OTHER, request);
  if (!env.TURNSTILE_SECRET_KEY || !env.SESSION_HMAC_SECRET) {
    throw new HttpError(503, "unavailable");
  }
  const ok = await verifyTurnstile(
    turnstileToken,
    clientIp(request),
    env.TURNSTILE_SECRET_KEY,
  );
  if (!ok) throw new HttpError(403, "turnstile");
  const { value, expiresAt } = await signSession(env.SESSION_HMAC_SECRET);
  return json({ expiresAt }, 200, {
    "set-cookie": `${COOKIE}=${value}; Max-Age=${SESSION_TTL_S}; Path=/api; HttpOnly; Secure; SameSite=Strict`,
  });
}
