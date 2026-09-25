import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { z } from "zod";
import { stringify } from "yaml";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { routeRegistry, type RegisteredRoute } from "./lib/route.js";

type Json = Record<string, unknown>;

const STATUS_TEXT: Record<number, string> = {
  200: "OK", 201: "Created", 204: "No Content", 400: "Invalid request (zod validation failed, malformed JSON, bad cursor)",
  401: "Unauthenticated", 403: "Forbidden", 404: "Not found", 409: "Conflict / version_mismatch",
  413: "Body too large", 429: "Rate limited", 503: "Service unavailable"
};

const schemaOf = (s: ZodTypeAny): Json => {
  const j = zodToJsonSchema(s, { target: "openApi3", $refStrategy: "none" }) as Json;
  delete j.$schema;
  return j;
};

function paramsFrom(shape: ZodTypeAny | undefined, where: "path" | "query"): Json[] {
  if (!shape) return [];
  const json = schemaOf(shape) as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, schema]) => ({
    name,
    in: where,
    required: where === "path" ? true : (json.required ?? []).includes(name),
    schema
  }));
}

const toOpenApiPath = (url: string) => url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
const operationId = (r: RegisteredRoute) =>
  r.method.toLowerCase() +
  toOpenApiPath(r.url)
    .split(/[/{}]+/)
    .filter(Boolean)
    .map((s) => s.replace(/(^|[-_])(\w)/g, (_m, _a, c: string) => c.toUpperCase()))
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");

function operation(r: RegisteredRoute): Json {
  const responses: Record<string, Json> = {};
  for (const [status, schema] of Object.entries(r.responses)) {
    const desc = STATUS_TEXT[Number(status)] ?? "Response";
    if (schema === null) responses[status] = { description: desc };
    else {
      const media = r.contentType ? r.contentType.split(";")[0]! : "application/json";
      responses[status] = { description: desc, content: { [media]: { schema: schemaOf(schema) } } };
    }
  }
  const errorStatuses = new Set([...(r.errors ?? []), ...(r.auth === "user" ? [401] : [])]);
  for (const s of [...errorStatuses].sort()) {
    if (responses[String(s)]) continue;
    responses[String(s)] = {
      description: STATUS_TEXT[s] ?? "Error",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } }
    };
  }
  const op: Json = {
    operationId: operationId(r),
    summary: r.summary,
    tags: r.tags,
    security: r.auth === "user" ? [{ bearerAuth: [] }, { cookieAuth: [], csrfToken: [] }] : [],
    responses
  };
  const descr = [r.description, r.access ? `**Access:** ${r.access}.` : undefined].filter(Boolean).join("\n\n");
  if (descr) op.description = descr;
  const parameters = [...paramsFrom(r.params, "path"), ...paramsFrom(r.query, "query")];
  if (parameters.length) op.parameters = parameters;
  if (r.body) {
    op.requestBody = {
      required: true,
      content: { [r.bodyContentType ?? "application/json"]: { schema: schemaOf(r.body) } }
    };
  }
  if (r.access) op["x-access"] = r.access;
  return op;
}

/** Builds the OpenAPI 3 document from the routes actually registered on the Fastify app (zod schemas -> JSON schema). */
export async function buildOpenApiDocument(): Promise<Json> {
  const cfg = loadConfig(
    { NODE_ENV: "test", SLINGER_SIGNING_SECRET: "openapi-generation-only", SLINGER_BASE_URL: "http://localhost:8080" },
    { warn: () => undefined }
  );
  const app = await buildApp({ config: cfg, logger: false });
  await app.ready();
  await app.close();

  const paths: Record<string, Record<string, Json>> = {};
  for (const r of routeRegistry) {
    const p = toOpenApiPath(r.url);
    (paths[p] ??= {})[r.method.toLowerCase()] = operation(r);
  }
  const error = z.object({
    error: z.object({
      code: z.enum([
        "invalid_request", "unauthenticated", "forbidden", "not_found", "conflict", "rate_limited",
        "workspace_access_denied", "version_mismatch", "invite_invalid", "join_request_not_allowed", "sync_conflict",
        "csrf_invalid", "origin_not_allowed", "internal_error"
      ]),
      message: z.string(),
      details: z.record(z.unknown()),
      request_id: z.string()
    })
  });
  return {
    openapi: "3.0.3",
    info: {
      title: "Slinger Cloud API",
      version: "2.0.0",
      description:
        "Generated from the zod schemas of the routes registered in `server/src`; do not edit by hand (`npm run openapi`).\n\n" +
        "Auth: `Authorization: Bearer <access token>` (desktop) or the `slinger_session` httpOnly cookie (dashboard). " +
        "Cookie-authenticated unsafe requests must send `X-CSRF-Token` (from `POST /v1/auth/browser/login` or `GET /v1/auth/browser/session`).\n\n" +
        "Every response carries `X-Request-Id`, echoed in `error.request_id`. List endpoints use cursor pagination " +
        "(`?cursor=&limit=&order=`) and return `{ items, page: { next_cursor, has_more } }`.\n\n" +
        "Behind the bundled Caddy proxy the same routes are reachable at `/v1/...` and, for the dashboard, `/api/v1/...`."
    },
    servers: [{ url: "http://localhost:8080", description: "Direct to the server container" }],
    tags: ["System", "Auth", "Workspaces", "Membership", "Hosts", "Content", "Sync", "Realtime", "Admin"].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        cookieAuth: { type: "apiKey", in: "cookie", name: "slinger_session" },
        csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token", description: "Required with cookieAuth on POST/PUT/PATCH/DELETE." }
      },
      schemas: { ErrorResponse: schemaOf(error) }
    }
  };
}

export async function buildOpenApiYaml(): Promise<string> {
  return stringify(await buildOpenApiDocument(), { lineWidth: 0 });
}
