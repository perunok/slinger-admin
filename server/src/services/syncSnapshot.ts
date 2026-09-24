import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { syncPayload } from "./content.js";
import { resourceTypes } from "./syncApply.js";
import type { SyncResourceType } from "./syncLog.js";

/** Parents before children so a client can insert page by page without dangling references. */
export const SNAPSHOT_ORDER: readonly SyncResourceType[] = [
  "collection", "environment", "folder", "request", "environment_variable", "collection_version"
];

/** Soft cap on the payload bytes of one page (at least one entity is always returned). */
const PAGE_BYTES = 8 * 1024 * 1024;
/** Collection version snapshots can be megabytes each: fetch them in small batches. */
const VERSION_BATCH = 20;

export const snapshotEntitySchema = z.object({
  resource_type: z.enum(resourceTypes),
  resource_id: z.string(),
  version: z.number().int(),
  payload: z.record(z.unknown())
});
export type SnapshotEntity = z.infer<typeof snapshotEntitySchema>;

type Cursor = { c: number; t: number; a: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(raw: string): Cursor {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      Number.isInteger(v.c) && v.c! >= 0 && Number.isInteger(v.t) && v.t! >= 0 && v.t! < SNAPSHOT_ORDER.length &&
      typeof v.a === "string" && v.a.length <= 64
    ) {
      return { c: v.c!, t: v.t!, a: v.a };
    }
  } catch {
    /* fall through */
  }
  throw new AppError("invalid_request", "invalid snapshot cursor", { field: "cursor" });
}

type Row = { id: string; version: number };
async function fetchRows(db: PrismaClient, wsId: string, type: SyncResourceType, after: string, take: number): Promise<Row[]> {
  const idAfter = after ? { gt: after } : undefined;
  const args = { orderBy: { id: "asc" as const }, take };
  switch (type) {
    case "collection": return db.collection.findMany({ where: { workspaceId: wsId, id: idAfter }, ...args });
    case "environment": return db.environment.findMany({ where: { workspaceId: wsId, id: idAfter }, ...args });
    case "folder": return db.folder.findMany({ where: { workspaceId: wsId, id: idAfter }, ...args });
    case "request": return db.request.findMany({ where: { workspaceId: wsId, id: idAfter }, ...args });
    case "environment_variable":
      return db.environmentVariable.findMany({ where: { environment: { workspaceId: wsId }, id: idAfter }, ...args });
    case "collection_version": return db.collectionVersion.findMany({ where: { workspaceId: wsId, id: idAfter }, ...args });
  }
}

/**
 * One page of the workspace's current state. Everything is scoped by `wsId` (the cursor carries no workspace),
 * so a cursor taken from another workspace can only ever yield this workspace's rows.
 */
export async function readSnapshotPage(db: PrismaClient, wsId: string, rawCursor: string | undefined, limit: number) {
  let cur: Cursor;
  if (rawCursor) {
    cur = decodeCursor(rawCursor);
  } else {
    // Read BEFORE the rows: anything written after this point is replayed by the follow-up pull.
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: wsId }, select: { syncCheckpoint: true } });
    cur = { c: ws.syncCheckpoint, t: 0, a: "" };
  }
  const checkpoint = cur.c;
  const entities: SnapshotEntity[] = [];
  let bytes = 0;
  let next: string | null = null;

  scan: while (cur.t < SNAPSHOT_ORDER.length) {
    const type = SNAPSHOT_ORDER[cur.t]!;
    const remaining = limit - entities.length;
    if (remaining <= 0) {
      // Page is full: only peek whether anything is left so the last page reports next_cursor = null.
      const peek = await fetchRows(db, wsId, type, cur.a, 1);
      if (peek.length > 0) {
        next = encodeCursor(cur);
        break;
      }
      cur = { c: cur.c, t: cur.t + 1, a: "" };
      continue;
    }
    const want = type === "collection_version" ? Math.min(remaining, VERSION_BATCH) : remaining;
    const rows = await fetchRows(db, wsId, type, cur.a, want + 1);
    for (const row of rows.slice(0, want)) {
      const payload = syncPayload(type, row);
      const size = JSON.stringify(payload).length + 200;
      if (entities.length > 0 && bytes + size > PAGE_BYTES) {
        next = encodeCursor(cur);
        break scan;
      }
      bytes += size;
      entities.push({ resource_type: type, resource_id: row.id, version: row.version, payload });
      cur = { c: cur.c, t: cur.t, a: row.id };
    }
    if (rows.length > want) {
      next = encodeCursor(cur); // more rows of this type follow the last one returned
      break;
    }
    cur = { c: cur.c, t: cur.t + 1, a: "" };
  }
  return { checkpoint, entities, next_cursor: next };
}
