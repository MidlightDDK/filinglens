import {
  type AnswerDone,
  buildPrompt,
  formatSSE,
  PROMPT_VERSION,
  type Usage,
} from "@filinglens/core";
import * as z from "zod/mini";
import { cacheKey, getCached, putCached, remapMarkers } from "./cache";
import type { Env } from "./env";
import {
  HttpError,
  log,
  rateLimit,
  readJson,
  requireMethod,
  requireSameOrigin,
} from "./http";
import { AllProvidersFailed, startChain } from "./providers/chain";
import { hasSession } from "./session";
import { loadSources, strategyFor } from "./sources";

const Body = z.object({
  question: z.string().check(z.trim(), z.minLength(1), z.maxLength(500)),
  chunkIds: z.array(z.string().check(z.regex(/^[A-Za-z0-9._-]{1,100}$/))).check(
    z.minLength(1),
    z.maxLength(10),
    z.refine((ids) => new Set(ids).size === ids.length),
  ),
  configId: z.string().check(z.maxLength(64)),
});

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** Dev-only fault injection: `X-Debug-Fail: workersAi,groq`. */
function forcedFailures(request: Request, env: Env): Set<string> {
  if (env.DEV_FLAGS !== "1") return new Set();
  const header = request.headers.get("x-debug-fail") ?? "";
  return new Set(
    header
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * POST /api/answer {question, chunkIds, configId} → SSE: `token {text}`...,
 * then `done {AnswerDone}` or `error {reason}`.
 */
export async function handleAnswer(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const t0 = Date.now();
  requireMethod(request, "POST");
  requireSameOrigin(request);
  const body = await readJson(request, Body);
  if (!(await hasSession(request, env))) throw new HttpError(401, "session");
  await rateLimit(env.RL_ANSWER, request);

  const sources = await loadSources(
    env,
    strategyFor(body.configId),
    body.chunkIds,
  );
  const key = await cacheKey(body.configId, body.question, body.chunkIds);
  const enc = new TextEncoder();

  // Fault-injected requests skip the cache in both directions.
  const forceFail = forcedFailures(request, env);
  const useCache = forceFail.size === 0;

  const cached = useCache ? await getCached(env.ANSWER_CACHE, key) : null;
  if (cached) {
    const done: AnswerDone = {
      provider: cached.provider,
      model: cached.model,
      promptVersion: PROMPT_VERSION,
      usage: cached.usage,
      latencyMs: Date.now() - t0,
      cached: true,
    };
    log({ route: "answer", provider: cached.provider, status: "cached" });
    const text = remapMarkers(cached.answer, cached.chunkIds, body.chunkIds);
    return new Response(
      enc.encode(formatSSE("token", { text }) + formatSSE("done", done)),
      { headers: SSE_HEADERS },
    );
  }

  let started: Awaited<ReturnType<typeof startChain>>;
  try {
    started = await startChain(buildPrompt(body.question, sources), env, {
      forceFail,
    });
  } catch (err) {
    if (!(err instanceof AllProvidersFailed)) throw err;
    log({
      route: "answer",
      status: 503,
      latencyMs: Date.now() - t0,
      provider: err.attempts
        .map((a) => `${a.provider}:${a.status ?? a.outcome}`)
        .join(","),
    });
    throw new HttpError(503, "quota");
  }

  const { provider, rest, abort } = started;
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const send = (event: string, data: unknown) =>
    writer.write(enc.encode(formatSSE(event, data)));

  const pump = async () => {
    let answer = started.first;
    let usage: Usage | null = null;
    let status: number | string = 200;
    try {
      await send("token", { text: started.first });
      for (;;) {
        const next = await rest.next();
        if (next.done) break;
        if (next.value.type === "token") {
          answer += next.value.text;
          await send("token", { text: next.value.text });
        } else {
          usage = next.value.usage;
        }
      }
      const done: AnswerDone = {
        provider: provider.id,
        model: provider.model,
        promptVersion: PROMPT_VERSION,
        usage,
        latencyMs: Date.now() - t0,
        cached: false,
      };
      await send("done", done);
      if (useCache) {
        await putCached(env.ANSWER_CACHE, key, {
          answer,
          chunkIds: body.chunkIds,
          provider: provider.id,
          model: provider.model,
          usage,
        });
      }
    } catch {
      // The provider failed mid-stream, or the client went away.
      abort();
      status = "stream_error";
      await send("error", { reason: "provider" }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
      log({
        route: "answer",
        provider: provider.id,
        status,
        latencyMs: Date.now() - t0,
        tokens: usage ? usage.prompt_tokens + usage.completion_tokens : 0,
      });
    }
  };
  ctx.waitUntil(pump());
  return new Response(readable, { headers: SSE_HEADERS });
}
