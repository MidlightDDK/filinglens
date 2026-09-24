import { PROMPT_VERSION } from "@filinglens/core";
import { handleAnswer } from "./answer";
import type { Env } from "./env";
import { HttpError, json, log, rateLimit, requireMethod } from "./http";
import { providerStatus } from "./providers/chain";
import { JUDGE_CHAIN } from "./providers/providers.config";
import { handleSession } from "./session";
import { handleVerify } from "./verify";

export type { Env } from "./env";

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  pathname: string,
): Promise<Response> {
  switch (pathname) {
    case "/api/health":
      requireMethod(request, "GET");
      await rateLimit(env.RL_OTHER, request);
      // Which providers could answer right now; never secrets.
      return json({
        status: "ok",
        promptVersion: PROMPT_VERSION,
        providers: providerStatus(env),
        judge: providerStatus(env, JUDGE_CHAIN),
      });
    case "/api/session":
      return handleSession(request, env);
    case "/api/answer":
      return handleAnswer(request, env, ctx);
    case "/api/verify":
      return handleVerify(request, env);
    default:
      throw new HttpError(404, "not_found");
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx, pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ reason: err.reason }, err.status, err.headers);
      }
      log({ route: pathname, status: 500 });
      console.error(err instanceof Error ? err.message : String(err));
      return json({ reason: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
