import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { defineRoute } from "../lib/route.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import {
  collectionSchema, environmentSchema, folderSchema, ok, okSchema, paged, requestSchema, toCollection,
  toEnvironment, toFolder, toRequest, toVariable, variableSchema
} from "../lib/dto.js";
import { requireWorkspaceRole } from "../auth/middleware.js";
import * as content from "../services/content.js";

const id = z.string().min(1).max(64);
const version = z.number().int().min(1);
const deleteQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const READ = "any active workspace member, or platform admin";
const WRITE = "workspace owner/admin/editor, or platform admin (viewers are read-only)";

const ws = { workspaceId: id };
const collectionParams = z.object({ ...ws, collectionId: id });
const folderParams = z.object({ ...ws, folderId: id });
const requestParams = z.object({ ...ws, requestId: id });
const envParams = z.object({ ...ws, environmentId: id });
const varParams = z.object({ ...ws, environmentId: id, key: content.variableKey });

export function registerContentRoutes(app: FastifyInstance): void {
  const secret = app.config.signingSecret;
  const read = requireWorkspaceRole("viewer");
  const write = requireWorkspaceRole("editor");
  const wsId = (req: { workspaceCtx?: { workspace: { id: string } } }) => req.workspaceCtx!.workspace.id;

  // ------------------------------------------------------------ collections
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/collections", summary: "List collections", access: READ,
    tags: ["Content"], auth: "user", pre: [read], params: z.object(ws), query: paginationQuerySchema,
    responses: { 200: paged(collectionSchema) }, errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const a = pageArgs(query);
      const rows = await prisma.collection.findMany({
        where: withCursor({ workspaceId: params.workspaceId }, a), orderBy: a.orderBy, take: a.take
      });
      return toPage(rows, query.limit, toCollection);
    }
  });
  defineRoute(app, {
    method: "POST", url: "/v1/workspaces/:workspaceId/collections", summary: "Create a collection", access: WRITE,
    tags: ["Content"], auth: "user", pre: [write], params: z.object(ws), body: content.collectionData,
    responses: { 201: z.object({ collection: collectionSchema }) }, errors: [400, 401, 403, 404],
    handler: async ({ req, body }) => ({
      collection: toCollection(await prisma.$transaction((tx) => content.createCollection(tx, wsId(req), body)))
    })
  });
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/collections/:collectionId", summary: "Get a collection",
    access: READ, tags: ["Content"], auth: "user", pre: [read], params: collectionParams,
    responses: { 200: z.object({ collection: collectionSchema }) }, errors: [401, 403, 404],
    handler: async ({ params }) => {
      const row = await prisma.collection.findFirst({ where: { id: params.collectionId, workspaceId: params.workspaceId } });
      if (!row) throw new AppError("not_found", "collection not found");
      return { collection: toCollection(row) };
    }
  });
  defineRoute(app, {
    method: "PATCH", url: "/v1/workspaces/:workspaceId/collections/:collectionId", summary: "Update a collection",
    access: WRITE, tags: ["Content"], auth: "user", pre: [write], params: collectionParams,
    body: content.collectionData.partial().extend({ version }).strict(),
    responses: { 200: z.object({ collection: collectionSchema }) }, errors: [400, 401, 403, 404, 409],
    handler: async ({ params, body }) => {
      const { version: v, ...d } = body;
      return {
        collection: toCollection(await prisma.$transaction((tx) => content.updateCollection(tx, params.workspaceId, params.collectionId, d, v)))
      };
    }
  });
  defineRoute(app, {
    method: "DELETE", url: "/v1/workspaces/:workspaceId/collections/:collectionId",
    summary: "Delete a collection (cascades to its folders and requests)", access: WRITE, tags: ["Content"],
    auth: "user", pre: [write], params: collectionParams, query: deleteQuery, responses: { 200: okSchema },
    errors: [401, 403, 404, 409],
    handler: async ({ params, query }) => {
      await prisma.$transaction((tx) => content.deleteCollection(tx, params.workspaceId, params.collectionId, query.version));
      return ok();
    }
  });

  // ------------------------------------------------------------ folders
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/collections/:collectionId/folders", summary: "List a collection's folders",
    access: READ, tags: ["Content"], auth: "user", pre: [read], params: collectionParams, query: paginationQuerySchema,
    responses: { 200: paged(folderSchema) }, errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const col = await prisma.collection.findFirst({ where: { id: params.collectionId, workspaceId: params.workspaceId } });
      if (!col) throw new AppError("not_found", "collection not found");
      const a = pageArgs(query);
      const rows = await prisma.folder.findMany({
        where: withCursor({ workspaceId: params.workspaceId, collectionId: col.id }, a), orderBy: a.orderBy, take: a.take
      });
      return toPage(rows, query.limit, toFolder);
    }
  });
  defineRoute(app, {
    method: "POST", url: "/v1/workspaces/:workspaceId/collections/:collectionId/folders", summary: "Create a folder",
    access: WRITE, tags: ["Content"], auth: "user", pre: [write], params: collectionParams, body: content.folderData,
    responses: { 201: z.object({ folder: folderSchema }) }, errors: [400, 401, 403, 404],
    handler: async ({ params, body }) => ({
      folder: toFolder(await prisma.$transaction((tx) => content.createFolder(tx, params.workspaceId, params.collectionId, body)))
    })
  });
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/folders/:folderId", summary: "Get a folder", access: READ,
    tags: ["Content"], auth: "user", pre: [read], params: folderParams,
    responses: { 200: z.object({ folder: folderSchema }) }, errors: [401, 403, 404],
    handler: async ({ params }) => {
      const row = await prisma.folder.findFirst({ where: { id: params.folderId, workspaceId: params.workspaceId } });
      if (!row) throw new AppError("not_found", "folder not found");
      return { folder: toFolder(row) };
    }
  });
  defineRoute(app, {
    method: "PATCH", url: "/v1/workspaces/:workspaceId/folders/:folderId", summary: "Rename/move a folder", access: WRITE,
    tags: ["Content"], auth: "user", pre: [write], params: folderParams,
    body: content.folderData.partial().extend({ version }).strict(),
    responses: { 200: z.object({ folder: folderSchema }) }, errors: [400, 401, 403, 404, 409],
    handler: async ({ params, body }) => {
      const { version: v, ...d } = body;
      return { folder: toFolder(await prisma.$transaction((tx) => content.updateFolder(tx, params.workspaceId, params.folderId, d, v))) };
    }
  });
  defineRoute(app, {
    method: "DELETE", url: "/v1/workspaces/:workspaceId/folders/:folderId",
    summary: "Delete a folder (cascades to child folders and their requests)", access: WRITE, tags: ["Content"],
    auth: "user", pre: [write], params: folderParams, query: deleteQuery, responses: { 200: okSchema },
    errors: [401, 403, 404, 409],
    handler: async ({ params, query }) => {
      await prisma.$transaction((tx) => content.deleteFolder(tx, params.workspaceId, params.folderId, query.version));
      return ok();
    }
  });

  // ------------------------------------------------------------ requests
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/collections/:collectionId/requests", summary: "List a collection's requests",
    access: READ, tags: ["Content"], auth: "user", pre: [read], params: collectionParams,
    query: paginationQuerySchema.extend({ folder_id: id.optional() }),
    responses: { 200: paged(requestSchema) }, errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const col = await prisma.collection.findFirst({ where: { id: params.collectionId, workspaceId: params.workspaceId } });
      if (!col) throw new AppError("not_found", "collection not found");
      const a = pageArgs(query);
      const rows = await prisma.request.findMany({
        where: withCursor({ workspaceId: params.workspaceId, collectionId: col.id, ...(query.folder_id && { folderId: query.folder_id }) }, a),
        orderBy: a.orderBy, take: a.take
      });
      return toPage(rows, query.limit, toRequest);
    }
  });
  defineRoute(app, {
    method: "POST", url: "/v1/workspaces/:workspaceId/collections/:collectionId/requests", summary: "Create a request",
    access: WRITE, tags: ["Content"], auth: "user", pre: [write], params: collectionParams, body: content.requestData,
    responses: { 201: z.object({ request: requestSchema }) }, errors: [400, 401, 403, 404],
    handler: async ({ params, body }) => ({
      request: toRequest(await prisma.$transaction((tx) => content.createRequest(tx, params.workspaceId, params.collectionId, body)))
    })
  });
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/requests/:requestId", summary: "Get a request", access: READ,
    tags: ["Content"], auth: "user", pre: [read], params: requestParams,
    responses: { 200: z.object({ request: requestSchema }) }, errors: [401, 403, 404],
    handler: async ({ params }) => {
      const row = await prisma.request.findFirst({ where: { id: params.requestId, workspaceId: params.workspaceId } });
      if (!row) throw new AppError("not_found", "request not found");
      return { request: toRequest(row) };
    }
  });
  defineRoute(app, {
    method: "PATCH", url: "/v1/workspaces/:workspaceId/requests/:requestId", summary: "Update a request", access: WRITE,
    tags: ["Content"], auth: "user", pre: [write], params: requestParams,
    body: content.requestData.partial().extend({ version }).strict(),
    responses: { 200: z.object({ request: requestSchema }) }, errors: [400, 401, 403, 404, 409],
    handler: async ({ params, body }) => {
      const { version: v, ...d } = body;
      return { request: toRequest(await prisma.$transaction((tx) => content.updateRequest(tx, params.workspaceId, params.requestId, d, v))) };
    }
  });
  defineRoute(app, {
    method: "DELETE", url: "/v1/workspaces/:workspaceId/requests/:requestId", summary: "Delete a request", access: WRITE,
    tags: ["Content"], auth: "user", pre: [write], params: requestParams, query: deleteQuery, responses: { 200: okSchema },
    errors: [401, 403, 404, 409],
    handler: async ({ params, query }) => {
      await prisma.$transaction((tx) => content.deleteRequest(tx, params.workspaceId, params.requestId, query.version));
      return ok();
    }
  });

  // ------------------------------------------------------------ environments
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/environments", summary: "List environments", access: READ,
    tags: ["Content"], auth: "user", pre: [read], params: z.object(ws), query: paginationQuerySchema,
    responses: { 200: paged(environmentSchema) }, errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const a = pageArgs(query);
      const rows = await prisma.environment.findMany({
        where: withCursor({ workspaceId: params.workspaceId }, a), orderBy: a.orderBy, take: a.take
      });
      return toPage(rows, query.limit, toEnvironment);
    }
  });
  defineRoute(app, {
    method: "POST", url: "/v1/workspaces/:workspaceId/environments", summary: "Create an environment", access: WRITE,
    tags: ["Content"], auth: "user", pre: [write], params: z.object(ws), body: content.environmentData,
    responses: { 201: z.object({ environment: environmentSchema }) }, errors: [400, 401, 403, 404],
    handler: async ({ req, body }) => ({
      environment: toEnvironment(await prisma.$transaction((tx) => content.createEnvironment(tx, wsId(req), body)))
    })
  });
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/environments/:environmentId", summary: "Get an environment",
    access: READ, tags: ["Content"], auth: "user", pre: [read], params: envParams,
    responses: { 200: z.object({ environment: environmentSchema }) }, errors: [401, 403, 404],
    handler: async ({ params }) => {
      const row = await prisma.environment.findFirst({ where: { id: params.environmentId, workspaceId: params.workspaceId } });
      if (!row) throw new AppError("not_found", "environment not found");
      return { environment: toEnvironment(row) };
    }
  });
  defineRoute(app, {
    method: "PATCH", url: "/v1/workspaces/:workspaceId/environments/:environmentId", summary: "Rename an environment",
    access: WRITE, tags: ["Content"], auth: "user", pre: [write], params: envParams,
    body: content.environmentData.partial().extend({ version }).strict(),
    responses: { 200: z.object({ environment: environmentSchema }) }, errors: [400, 401, 403, 404, 409],
    handler: async ({ params, body }) => {
      const { version: v, ...d } = body;
      return {
        environment: toEnvironment(await prisma.$transaction((tx) => content.updateEnvironment(tx, params.workspaceId, params.environmentId, d, v)))
      };
    }
  });
  defineRoute(app, {
    method: "DELETE", url: "/v1/workspaces/:workspaceId/environments/:environmentId",
    summary: "Delete an environment and its variables", access: WRITE, tags: ["Content"], auth: "user", pre: [write],
    params: envParams, query: deleteQuery, responses: { 200: okSchema }, errors: [401, 403, 404, 409],
    handler: async ({ params, query }) => {
      await prisma.$transaction((tx) => content.deleteEnvironment(tx, params.workspaceId, params.environmentId, query.version));
      return ok();
    }
  });

  // ------------------------------------------------------------ environment variables
  defineRoute(app, {
    method: "GET", url: "/v1/workspaces/:workspaceId/environments/:environmentId/variables",
    summary: "List variables (secret values are masked server-side: `value` null, `masked_value` set)", access: READ,
    tags: ["Content"], auth: "user", pre: [read], params: envParams, query: paginationQuerySchema,
    responses: { 200: paged(variableSchema) }, errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const env = await prisma.environment.findFirst({ where: { id: params.environmentId, workspaceId: params.workspaceId } });
      if (!env) throw new AppError("not_found", "environment not found");
      const a = pageArgs(query);
      const rows = await prisma.environmentVariable.findMany({
        where: withCursor({ environmentId: env.id }, a), orderBy: a.orderBy, take: a.take
      });
      return toPage(rows, query.limit, toVariable);
    }
  });
  defineRoute(app, {
    method: "PUT", url: "/v1/workspaces/:workspaceId/environments/:environmentId/variables/:key",
    summary: "Create or replace a variable (201 when created, 200 when replaced)",
    description:
      "`version` is optional; when sent and the variable exists it must match (409 version_mismatch otherwise). " +
      "Secret values are write-only: encrypted at rest and never returned by any endpoint.",
    access: WRITE, tags: ["Content"], auth: "user", pre: [write], params: varParams,
    body: content.variableData.extend({ version: version.optional() }).strict(),
    responses: { 200: z.object({ variable: variableSchema }), 201: z.object({ variable: variableSchema }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ reply, params, body }) => {
      const { version: v, ...d } = body;
      const { row, created } = await prisma.$transaction((tx) =>
        content.putVariable(tx, params.workspaceId, params.environmentId, params.key, d, secret, v)
      );
      reply.code(created ? 201 : 200);
      return { variable: toVariable(row) };
    }
  });
  defineRoute(app, {
    method: "DELETE", url: "/v1/workspaces/:workspaceId/environments/:environmentId/variables/:key",
    summary: "Delete a variable", access: WRITE, tags: ["Content"], auth: "user", pre: [write], params: varParams,
    query: deleteQuery, responses: { 200: okSchema }, errors: [401, 403, 404, 409],
    handler: async ({ params, query }) => {
      await prisma.$transaction((tx) =>
        content.deleteVariable(tx, params.workspaceId, params.environmentId, params.key, query.version)
      );
      return ok();
    }
  });
}
