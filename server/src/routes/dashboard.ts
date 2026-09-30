import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/**
 * Serves the built admin dashboard (admin-dashboard/dist, copied into the Docker image) from the same origin as the API,
 * so the image needs no second web server. The dashboard uses hash routes (/#/users), so "/" and the files in the build are
 * all there is: an unknown path is still the API's JSON 404.
 *
 * The API's global headers are meant for JSON (Cache-Control: no-store, a CSP that allows nothing); dashboard responses
 * replace them: a CSP that lets the app load its own scripts, styles and API calls, long caching for the content-hashed
 * files under /assets/ and revalidation for everything else (index.html must never be stale after an upgrade).
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Svelte sets style attributes at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

/** The dashboard's API prefix: same origin, "/api" (stripped again by the server, see `stripApiPrefix`). */
const RUNTIME_CONFIG = `window.__SLINGER_API_BASE_URL__ = ${JSON.stringify("/api")};\n`;

export async function registerDashboard(app: FastifyInstance, root: string): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook("onSend", async (req, reply, payload) => {
      if (reply.statusCode >= 400) return payload;
      reply.header("Content-Security-Policy", DASHBOARD_CSP);
      const path = req.url.split("?")[0];
      reply.header("Cache-Control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return payload;
    });

    // Replaces the placeholder in the build (a specific route wins over the static wildcard).
    scope.get("/runtime-config.js", async (_req, reply) => {
      return reply.type("text/javascript; charset=utf-8").send(RUNTIME_CONFIG);
    });

    await scope.register(fastifyStatic, {
      root,
      prefix: "/",
      // Cache-Control is set by the hook above.
      cacheControl: false,
      // The plugin serves dotfiles by default; nothing in a build needs one.
      dotfiles: "ignore",
      decorateReply: false
    });
  });
}

/**
 * The dashboard calls the API as /api/v1/...; behind the old two-container setup Caddy stripped that prefix. The server now
 * accepts both forms, so any reverse proxy in front can pass everything through unchanged.
 */
export function stripApiPrefix(url: string): string {
  if (url !== "/api" && !url.startsWith("/api/") && !url.startsWith("/api?")) return url;
  const rest = url.slice(4);
  return rest.startsWith("/") ? rest : `/${rest}`;
}
