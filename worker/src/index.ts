export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      }
      return Response.json({ status: "ok", providers: [] });
    }
    if (pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
