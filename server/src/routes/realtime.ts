import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { defineRoute } from "../lib/route.js";
import { ROLE_RANK, requireWorkspaceRole } from "../auth/middleware.js";
import { AUDIENCE_COLLAB, AUDIENCE_REALTIME, signScopedToken } from "../auth/jwt.js";

const TOKEN_TTL_SECONDS = 900;
const wsParams = z.object({ workspaceId: z.string().min(1).max(64) });

/**
 * Thin signed-token issuers for the (separate, not yet built) realtime/collab services.
 * They only assert "this user may join these channels/rooms of this workspace"; no realtime logic lives here.
 */
export function registerRealtimeRoutes(app: FastifyInstance): void {
  const secret = app.config.signingSecret;

  const scopeClaims = (req: import("fastify").FastifyRequest) => {
    const { membership } = req.workspaceCtx!;
    const role = membership?.role ?? null;
    return {
      workspace_id: req.workspaceCtx!.workspace.id,
      role,
      platform_role: req.auth!.user.platformRole,
      can_write: role ? ROLE_RANK[role] >= ROLE_RANK.editor : req.auth!.user.platformRole !== "user"
    };
  };

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/realtime/token",
    summary: "Issue a short-lived realtime token (channels limited to this workspace's presence/events)",
    access: "any active workspace member, or platform admin",
    tags: ["Realtime"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: wsParams,
    body: z.object({ channels: z.array(z.string().max(200)).max(10).optional() }),
    responses: { 200: z.object({ token: z.string(), expires_in: z.number().int(), channels: z.array(z.string()) }) },
    errors: [400, 401, 403, 404],
    handler: async ({ req, params, body }) => {
      const allowed = [`workspace:${params.workspaceId}:presence`, `workspace:${params.workspaceId}:events`];
      const channels = body.channels ?? allowed;
      if (channels.length === 0 || channels.some((c) => !allowed.includes(c))) {
        throw new AppError("invalid_request", "channels must be this workspace's presence/events channels", { allowed });
      }
      const token = await signScopedToken(secret, AUDIENCE_REALTIME, req.auth!.user.id, TOKEN_TTL_SECONDS, {
        ...scopeClaims(req),
        channels
      });
      return { token, expires_in: TOKEN_TTL_SECONDS, channels };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/collab/rooms/token",
    summary: "Issue a short-lived collaboration room token (`can_write` claim is false for viewers)",
    description: "`room_key` format: `workspace:{workspace_id}:document:{request|environment|collection}:{resource_id}`.",
    access: "any active workspace member, or platform admin",
    tags: ["Realtime"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: wsParams,
    body: z.object({ room_key: z.string().max(300) }),
    responses: { 200: z.object({ token: z.string(), room_key: z.string(), expires_in: z.number().int() }) },
    errors: [400, 401, 403, 404],
    handler: async ({ req, params, body }) => {
      const re = new RegExp(`^workspace:${params.workspaceId.replace(/[^A-Za-z0-9-]/g, "")}:document:(request|environment|collection):[A-Za-z0-9-]{1,64}$`);
      if (!re.test(body.room_key)) {
        throw new AppError("invalid_request", "room_key must belong to this workspace and match workspace:{id}:document:{type}:{resource_id}");
      }
      const token = await signScopedToken(secret, AUDIENCE_COLLAB, req.auth!.user.id, TOKEN_TTL_SECONDS, {
        ...scopeClaims(req),
        room_key: body.room_key
      });
      return { token, room_key: body.room_key, expires_in: TOKEN_TTL_SECONDS };
    }
  });
}
