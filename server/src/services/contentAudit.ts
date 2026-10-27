import type { Prisma } from "@prisma/client";
import { writeAuditLog } from "../lib/auditLog.js";
import type { SyncResourceType } from "./syncLog.js";

type Tx = Prisma.TransactionClient;

/**
 * Who changed what in a workspace's content: one audit row per created, updated or deleted item (collection, folder,
 * request, environment, variable, collection version), whether it came from a desktop sync push or the REST API.
 *
 * `details` (all optional):
 * - `name`: the item's name (variable key, version label); `collection` / `environment`: its container's name;
 * - `changes`: what an update changed: `{ field, from?, to? }`. Short fields carry their old and new value (truncated);
 *   large or sensitive ones (request documents, scripts, docs, auth, snapshots) only their name, never their content.
 *   A request document is broken down into the parts that changed (`headers`, `body`, `auth`, `params`, `scripts`, ...);
 * - `removed`: for a deleted collection, folder or environment, how many items went with it;
 * - `device`: the desktop device a sync push came from (absent for REST/dashboard edits).
 * Secret variable values never reach this point: the sync payload already carries `value: null` for them.
 */
export type ContentChange = { field: string; from?: unknown; to?: unknown };

/** Fields whose old and new values are shown (short, never secret). */
const VALUE_FIELDS = new Set(["name", "method", "url", "key", "value", "enabled", "is_secret", "semver", "description_type"]);
/** Fields not worth an entry of their own: positions in a list, counters derived from other data. */
const IGNORED_FIELDS = new Set(["sort_order", "folder_count", "request_count", "created_at", "created_by"]);
/** Readable names for payload fields. */
const FIELD_LABELS: Record<string, string> = {
  collection_id: "collection",
  folder_id: "folder",
  parent_folder_id: "parent folder",
  environment_id: "environment",
  is_secret: "secret",
  scripts_json: "scripts",
  auth_json: "auth",
  description: "docs",
  description_type: "docs format",
  semver: "version",
  snapshot_json: "snapshot",
  notes: "notes"
};
const MAX_VALUE = 200;

function shown(v: unknown): unknown {
  if (typeof v === "string" && v.length > MAX_VALUE) return `${v.slice(0, MAX_VALUE)}…`;
  return v;
}

function parse(json: unknown): Record<string, unknown> | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which parts of a request's Postman item document changed (names only). */
export function documentParts(before: unknown, after: unknown): string[] {
  const a = parse(before);
  const b = parse(after);
  if (!a || !b) return ["request details"];
  const req = (d: Record<string, unknown>) => (d.request && typeof d.request === "object" ? (d.request as Record<string, unknown>) : {});
  const url = (d: Record<string, unknown>) => {
    const u = req(d).url;
    return u && typeof u === "object" ? (u as Record<string, unknown>) : {};
  };
  const parts: [string, (d: Record<string, unknown>) => unknown][] = [
    ["headers", (d) => req(d).header],
    ["body", (d) => req(d).body],
    ["auth", (d) => req(d).auth],
    ["params", (d) => url(d).query],
    ["path variables", (d) => url(d).variable],
    ["scripts", (d) => d.event],
    ["docs", (d) => req(d).description ?? d.description],
    ["examples", (d) => d.response],
    ["settings", (d) => d.protocolProfileBehavior],
    ["mcp", (d) => d.mcp]
  ];
  const changed = parts.filter(([, get]) => !same(get(a), get(b))).map(([name]) => name);
  if (changed.length) return changed;
  return same(a, b) ? [] : ["request details"];
}

/** The fields that differ between two sync payloads of one item. */
export function diffPayloads(type: SyncResourceType, before: Record<string, unknown>, after: Record<string, unknown>): ContentChange[] {
  const changes: ContentChange[] = [];
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED_FIELDS.has(field) || same(before[field], after[field])) continue;
    if (field === "document_json" && type === "request") {
      for (const part of documentParts(before[field], after[field])) changes.push({ field: part });
      continue;
    }
    // A secret variable's value is null in the payload: say it changed, never what to.
    if (field === "value" && (before.is_secret === true || after.is_secret === true)) {
      changes.push({ field: "value" });
      continue;
    }
    const label = FIELD_LABELS[field] ?? field;
    if (VALUE_FIELDS.has(field)) changes.push({ field: label, from: shown(before[field] ?? null), to: shown(after[field] ?? null) });
    else changes.push({ field: label });
  }
  // A move between folders or collections changes only positions otherwise: still worth one entry.
  if (!changes.length && ["sort_order"].some((f) => !same(before[f], after[f]))) changes.push({ field: "position" });
  // A secret's value is never in the payload: an update of a secret variable that changed nothing else changed its value.
  if (!changes.length && after.is_secret === true) changes.push({ field: "value" });
  return changes;
}

function nameOf(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  for (const k of ["name", "key", "semver"]) if (typeof payload[k] === "string" && payload[k]) return payload[k] as string;
  return undefined;
}

export type AuditCtx = {
  actorUserId?: string | null;
  clientId?: string | null;
  requestId?: string | null;
};

/**
 * Writes the audit row for one content change, in the mutation's transaction. `before` is the item's previous sync
 * payload (null when it is new), `after` its new one (null when it was deleted). An update that changed nothing visible
 * writes nothing.
 */
export async function auditContentChange(
  tx: Tx,
  wsId: string,
  type: SyncResourceType,
  resourceId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  ctx: AuditCtx,
  extra: { removed?: Record<string, number>; version?: number } = {}
): Promise<void> {
  // No previous state but a version above 1: an item last written before the sync log kept it. Updated, changes unknown.
  const action = !after ? "content.deleted" : before || (extra.version ?? 1) > 1 ? "content.updated" : "content.created";
  const details: Record<string, unknown> = {};
  if (action === "content.updated" && before && after) {
    const changes = diffPayloads(type, before, after);
    if (!changes.length) return;
    details.changes = changes;
  }
  const current = after ?? before;
  const name = nameOf(current);
  if (name) details.name = name;
  if (type === "request" && typeof current?.method === "string") details.method = current.method;

  const collectionId = typeof current?.collection_id === "string" ? current.collection_id : null;
  if (collectionId && type !== "collection") {
    const col = await tx.collection.findUnique({ where: { id: collectionId }, select: { name: true } });
    if (col) details.collection = col.name;
  }
  const environmentId = typeof current?.environment_id === "string" ? current.environment_id : null;
  if (environmentId) {
    const env = await tx.environment.findUnique({ where: { id: environmentId }, select: { name: true } });
    if (env) details.environment = env.name;
  }
  if (extra.removed && Object.values(extra.removed).some((n) => n > 0)) details.removed = extra.removed;
  if (ctx.clientId) {
    const client = await tx.syncClient.findUnique({ where: { id: ctx.clientId }, select: { deviceName: true, clientName: true } });
    const device = client?.deviceName || client?.clientName;
    if (device) details.device = device;
  }

  await writeAuditLog(tx, {
    actorUserId: ctx.actorUserId ?? null,
    action,
    resourceType: type,
    resourceId,
    workspaceId: wsId,
    requestId: ctx.requestId ?? null,
    details
  });
}
