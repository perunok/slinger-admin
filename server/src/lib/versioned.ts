import { AppError } from "./errors.js";

/**
 * After an `updateMany({ where: { id, workspaceId, version } })` optimistic-concurrency write:
 * count 1 = success; otherwise distinguish "does not exist in this scope" (404) from "stale version" (409).
 */
export async function ensureUpdated(count: number, lookup: () => Promise<{ version: number } | null>): Promise<void> {
  if (count === 1) return;
  const current = await lookup();
  if (!current) throw new AppError("not_found", "resource not found");
  throw new AppError("version_mismatch", "resource was modified by someone else; refetch and retry", {
    current_version: current.version
  });
}

/** For deletes where `version` is optional. */
export function assertVersionIfGiven(current: { version: number }, expected: number | undefined): void {
  if (expected !== undefined && expected !== current.version) {
    throw new AppError("version_mismatch", "resource was modified by someone else; refetch and retry", {
      current_version: current.version
    });
  }
}
