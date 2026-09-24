import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { authenticate } from "../auth/middleware.js";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type ZAny = z.ZodTypeAny;
type Infer<T> = T extends ZAny ? z.infer<T> : undefined;

export type RouteSpec<P extends ZAny | undefined, Q extends ZAny | undefined, B extends ZAny | undefined> = {
  method: Method;
  url: string;
  summary: string;
  description?: string;
  tags: string[];
  /** `public` = no credentials needed; `user` = Bearer token or session cookie. */
  auth: "public" | "user";
  /** Human-readable authorization rule, published in the OpenAPI document and README. */
  access?: string;
  /** Extra preHandlers that run after authentication (e.g. requireWorkspaceRole / requirePlatformRole). */
  pre?: preHandlerAsyncHookHandler[];
  params?: P;
  query?: Q;
  body?: B;
  /** Success responses; the first key is the default status code. `null` means no body. */
  responses: Record<number, ZAny | null>;
  /** Additional documented error statuses. */
  errors?: number[];
  /** Response media type when not JSON (HTML pages). Such responses are sent as-is. */
  contentType?: string;
  /** Request media type when not JSON (urlencoded HTML forms). */
  bodyContentType?: string;
  /** Fastify route config (e.g. rate limit). */
  config?: Record<string, unknown>;
  handler: (c: {
    req: FastifyRequest;
    reply: FastifyReply;
    params: Infer<P>;
    query: Infer<Q>;
    body: Infer<B>;
  }) => Promise<unknown>;
};

export type RegisteredRoute = Omit<RouteSpec<ZAny | undefined, ZAny | undefined, ZAny | undefined>, "handler" | "pre">;

export const routeRegistry: RegisteredRoute[] = [];

/** Set by buildApp in tests: every JSON response is checked against its declared schema (exact match). */
export const responseValidation = { enabled: false };

/**
 * Registers a route and records its schemas. Parsing params/query/body with zod happens here, AFTER
 * authentication and authorization preHandlers, so unauthenticated callers never get validation feedback.
 */
export function defineRoute<
  P extends ZAny | undefined = undefined,
  Q extends ZAny | undefined = undefined,
  B extends ZAny | undefined = undefined
>(app: FastifyInstance, spec: RouteSpec<P, Q, B>): void {
  const { handler, pre, ...meta } = spec;
  if (!routeRegistry.some((r) => r.method === meta.method && r.url === meta.url)) {
    routeRegistry.push(meta as RegisteredRoute);
  }
  const statuses = Object.keys(spec.responses).map(Number);
  const defaultStatus = statuses[0] ?? 200;

  app.route({
    method: spec.method,
    url: spec.url,
    config: spec.config,
    preHandler: [...(spec.auth === "user" ? [authenticate as preHandlerAsyncHookHandler] : []), ...(pre ?? [])],
    handler: async (req, reply) => {
      const params = (spec.params ? spec.params.parse(req.params) : undefined) as Infer<P>;
      const query = (spec.query ? spec.query.parse(req.query) : undefined) as Infer<Q>;
      const body = (spec.body ? spec.body.parse(req.body ?? {}) : undefined) as Infer<B>;
      const result = await handler({ req, reply, params, query, body });
      if (reply.sent) return reply;
      const status = reply.statusCode !== 200 ? reply.statusCode : defaultStatus;
      if (spec.contentType) return reply.code(status).type(spec.contentType).send(result);
      const schema = spec.responses[status];
      if (schema === null || status === 204) return reply.code(status).send();
      if (responseValidation.enabled && schema) {
        const parsed = schema.parse(JSON.parse(JSON.stringify(result)));
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(result)))) {
          throw new Error(`Response for ${spec.method} ${spec.url} does not exactly match its declared schema`);
        }
      } else if (responseValidation.enabled && !schema) {
        throw new Error(`Response status ${status} for ${spec.method} ${spec.url} is not declared`);
      }
      return reply.code(status).send(result);
    }
  });
}
