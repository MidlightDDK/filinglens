import {
  buildSupportPrompt,
  claimsOf,
  JUDGE_VERSION,
  parseSupportVerdicts,
  type SupportVerdict,
  type VerifyResponse,
} from "@filinglens/core";
import * as z from "zod/mini";
import { getCached, putCached, verifyCacheKey } from "./cache";
import type { Env } from "./env";
import {
  HttpError,
  json,
  log,
  rateLimit,
  readJson,
  requireMethod,
  requireSameOrigin,
} from "./http";
import {
  AllProvidersFailed,
  judgeProviders,
  startChain,
} from "./providers/chain";
import { hasSession } from "./session";
import { loadSources, strategyFor } from "./sources";

const Body = z.object({
  question: z.string().check(z.trim(), z.minLength(1), z.maxLength(500)),
  answer: z.string().check(z.trim(), z.minLength(1), z.maxLength(4000)),
  chunkIds: z.array(z.string().check(z.regex(/^[A-Za-z0-9._-]{1,100}$/))).check(
    z.minLength(1),
    z.maxLength(10),
    z.refine((ids) => new Set(ids).size === ids.length),
  ),
  configId: z.string().check(z.maxLength(64)),
});

interface CachedVerdicts {
  verdicts: SupportVerdict[];
  provider: string;
  model: string;
}

/**
 * POST /api/verify {question, answer, chunkIds, configId} → VerifyResponse:
 * the support judge's verdict on each cited sentence of `answer`, judged
 * against the same sources (loaded here, never sent by the client).
 */
export async function handleVerify(
  request: Request,
  env: Env,
): Promise<Response> {
  const t0 = Date.now();
  requireMethod(request, "POST");
  requireSameOrigin(request);
  const body = await readJson(request, Body);
  if (!(await hasSession(request, env))) throw new HttpError(401, "session");
  await rateLimit(env.RL_ANSWER, request);

  const claims = claimsOf(body.answer, body.chunkIds);
  const strategy = strategyFor(body.configId);
  const reply = (v: CachedVerdicts, cached: boolean) =>
    json({
      ...v,
      judgeVersion: JUDGE_VERSION,
      cached,
    } satisfies VerifyResponse);
  if (claims.length === 0) {
    return reply({ verdicts: [], provider: "none", model: "none" }, false);
  }

  const key = await verifyCacheKey(
    body.configId,
    body.question,
    body.answer,
    body.chunkIds,
  );
  const hit = await getCached<CachedVerdicts>(env.ANSWER_CACHE, key);
  if (hit) {
    log({ route: "verify", provider: hit.provider, status: "cached" });
    return reply(hit, true);
  }

  const sources = await loadSources(env, strategy, body.chunkIds);
  const messages = buildSupportPrompt(body.question, claims, sources);
  let started: Awaited<ReturnType<typeof startChain>>;
  try {
    started = await startChain(messages, env, { providers: judgeProviders() });
  } catch (err) {
    if (!(err instanceof AllProvidersFailed)) throw err;
    log({ route: "verify", status: 503, latencyMs: Date.now() - t0 });
    throw new HttpError(503, "quota");
  }

  const { provider, rest, abort } = started;
  let text = started.first;
  let tokens = 0;
  try {
    for (;;) {
      const next = await rest.next();
      if (next.done) break;
      if (next.value.type === "token") text += next.value.text;
      else if (next.value.usage) {
        tokens =
          next.value.usage.prompt_tokens + next.value.usage.completion_tokens;
      }
    }
  } catch {
    abort();
    log({ route: "verify", provider: provider.id, status: "stream_error" });
    throw new HttpError(502, "provider");
  }

  const verdicts = parseSupportVerdicts(text, claims);
  log({
    route: "verify",
    provider: provider.id,
    status: verdicts.length > 0 ? 200 : "unparsable",
    latencyMs: Date.now() - t0,
    tokens,
  });
  if (verdicts.length === 0) throw new HttpError(502, "provider");
  const result = { verdicts, provider: provider.id, model: provider.model };
  await putCached(env.ANSWER_CACHE, key, result);
  return reply(result, false);
}
