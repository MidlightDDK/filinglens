export const MAX_BODY_BYTES = 16 * 1024;

/** An expected failure, returned to the client as `{reason}`. */
export class HttpError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly headers: HeadersInit | undefined;
  constructor(status: number, reason: string, headers?: HeadersInit) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.headers = headers;
  }
}

export function json(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const res = Response.json(body, { status, headers });
  res.headers.set("cache-control", "no-store");
  return res;
}

export function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new HttpError(405, "method_not_allowed", { allow: method });
  }
}

/** Same-origin only: browsers send Origin on every cross-site or POST request. */
export function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new HttpError(403, "origin");
  }
}

/** Any zod (or zod/mini) schema. */
interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

export async function readJson<T>(
  request: Request,
  schema: Schema<T>,
): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, "too_large");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HttpError(400, "invalid");
  return parsed.data;
}

export const clientIp = (request: Request) =>
  request.headers.get("cf-connecting-ip") ?? "unknown";

/** Approximate, per Cloudflare location (fine for a demo). */
export async function rateLimit(
  limiter: RateLimit,
  request: Request,
): Promise<void> {
  const { success } = await limiter.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limit", { "retry-after": "60" });
}

/** Structured log line. Never includes question text or IPs. */
export function log(entry: {
  route: string;
  provider?: string;
  status: number | string;
  latencyMs?: number;
  tokens?: number;
}): void {
  console.log(JSON.stringify(entry));
}
