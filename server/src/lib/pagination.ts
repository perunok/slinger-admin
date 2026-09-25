import { z } from "zod";
import { AppError } from "./errors.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  order: z.enum(["asc", "desc"]).default("asc")
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export type CursorParts = { createdAt: Date; id: string };

/** Cursor = base64url("<created_at_iso>|<id>"), per the API contract. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorParts | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.indexOf("|");
    if (sep < 0) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!iso || !id || id.length > 64) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export type PageArgs = {
  take: number;
  orderBy: [{ createdAt: "asc" | "desc" }, { id: "asc" | "desc" }];
  /** Merge into the query `where` via AND. Undefined for the first page. */
  cursorWhere: { OR: Array<Record<string, unknown>> } | undefined;
};

/** Builds Prisma args for keyset pagination ordered by (createdAt, id). Fetches limit + 1 rows. */
export function pageArgs(q: PaginationQuery): PageArgs {
  let cursorWhere: PageArgs["cursorWhere"];
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) throw new AppError("invalid_request", "invalid cursor", { field: "cursor" });
    const cmp = q.order === "asc" ? "gt" : "lt";
    cursorWhere = {
      OR: [{ createdAt: { [cmp]: c.createdAt } }, { createdAt: c.createdAt, id: { [cmp]: c.id } }]
    };
  }
  return { take: q.limit + 1, orderBy: [{ createdAt: q.order }, { id: q.order }], cursorWhere };
}

/** Combine a base where-clause with the cursor clause. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withCursor<W extends object>(base: W, args: PageArgs): W & { AND?: any[] } {
  return args.cursorWhere ? { ...base, AND: [args.cursorWhere] } : base;
}

export type Page<T> = { items: T[]; page: { next_cursor: string | null; has_more: boolean } };

/** Split `limit + 1` fetched rows into the page and its metadata. */
export function toPage<T extends { createdAt: Date; id: string }, O>(
  rows: T[],
  limit: number,
  map: (row: T) => O
): Page<O> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    page: { next_cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null, has_more: hasMore }
  };
}

// ---------------------------------------------------------------- (sort_order, id) paging for folders and requests
// Lists of tree nodes follow the order the desktop shows (`sort_order`, ties by `id`), see docs/SYNC_DESIGN.md D9.
// The cursor is base64url("<sort_order>#<id>"): different from the created_at cursor, so the two can't be mixed up.

export function encodeSortCursor(sortOrder: number, id: string): string {
  return Buffer.from(`${sortOrder}#${id}`, "utf8").toString("base64url");
}

export function decodeSortCursor(cursor: string): { sortOrder: number; id: string } | null {
  const m = /^(\d{1,10})#(.{1,64})$/s.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m ? { sortOrder: Number(m[1]), id: m[2]! } : null;
}

export type SortedPageArgs = {
  take: number;
  orderBy: [{ sortOrder: "asc" | "desc" }, { id: "asc" | "desc" }];
  cursorWhere: { OR: Array<Record<string, unknown>> } | undefined;
};

export function sortedPageArgs(q: PaginationQuery): SortedPageArgs {
  let cursorWhere: SortedPageArgs["cursorWhere"];
  if (q.cursor) {
    const c = decodeSortCursor(q.cursor);
    if (!c) throw new AppError("invalid_request", "invalid cursor", { field: "cursor" });
    const cmp = q.order === "asc" ? "gt" : "lt";
    cursorWhere = { OR: [{ sortOrder: { [cmp]: c.sortOrder } }, { sortOrder: c.sortOrder, id: { [cmp]: c.id } }] };
  }
  return { take: q.limit + 1, orderBy: [{ sortOrder: q.order }, { id: q.order }], cursorWhere };
}

export function withSortedCursor<W extends object>(base: W, args: SortedPageArgs): W & { AND?: any[] } {
  return args.cursorWhere ? { ...base, AND: [args.cursorWhere] } : base;
}

export function toSortedPage<T extends { sortOrder: number; id: string }, O>(rows: T[], limit: number, map: (row: T) => O): Page<O> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    page: { next_cursor: hasMore && last ? encodeSortCursor(last.sortOrder, last.id) : null, has_more: hasMore }
  };
}
