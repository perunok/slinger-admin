import type { SyncResourceType } from "./syncLog.js";

/**
 * Additive extensions of sync protocol v2 (slinger docs/SYNC_DESIGN.md section 21). A client declares the ones it
 * understands on every sync call (`features` query parameter on pull/snapshot, `features` array in the push body);
 * everything it did not declare is left out of what we return, so older clients see exactly the v2 wire they know.
 */
export const EXTENSION_FEATURES = ["folder_scripts", "docs", "collection_variables", "globals", "version_authors", "container_auth"] as const;
export type ExtensionFeature = (typeof EXTENSION_FEATURES)[number];

/** Resource types that only exist for clients declaring the feature. */
const TYPE_FEATURE: Partial<Record<SyncResourceType, ExtensionFeature>> = {
  collection_variable: "collection_variables",
  global_variable: "globals"
};
/** Collection/folder payload fields that only exist for clients declaring the feature. */
const FIELD_FEATURE: Record<string, ExtensionFeature> = {
  scripts_json: "folder_scripts",
  description: "docs",
  description_type: "docs",
  auth_json: "container_auth"
};

/** Parses a declaration (comma separated string or array); unknown names are ignored. */
export function clientFeatures(raw: string | string[] | undefined | null): ReadonlySet<ExtensionFeature> {
  const names = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const known = new Set<string>(EXTENSION_FEATURES);
  return new Set(names.map((n) => n.trim()).filter((n): n is ExtensionFeature => known.has(n)));
}

/** Whether a client with `features` may see resources of `type`. */
export function typeVisible(type: string, features: ReadonlySet<ExtensionFeature>): boolean {
  const f = TYPE_FEATURE[type as SyncResourceType];
  return !f || features.has(f);
}

/**
 * The payload as a client with `features` sees it: undeclared collection/folder fields are removed, and a
 * `collection_version` carries `created_by` only for clients declaring `version_authors` (`null` when the payload was
 * logged before authors were recorded).
 */
export function shapePayload(type: string, payload: Record<string, unknown>, features: ReadonlySet<ExtensionFeature>): Record<string, unknown> {
  if (type === "collection_version") {
    // Tombstones have an empty payload and stay empty.
    if (features.has("version_authors")) return "created_by" in payload || !("semver" in payload) ? payload : { ...payload, created_by: null };
    if (!("created_by" in payload)) return payload;
    const { created_by: _author, ...rest } = payload;
    return rest;
  }
  if (type !== "collection" && type !== "folder") return payload;
  let out: Record<string, unknown> | null = null;
  for (const [field, feature] of Object.entries(FIELD_FEATURE)) {
    if (field in payload && !features.has(feature)) {
      out ??= { ...payload };
      delete out[field];
    }
  }
  return out ?? payload;
}
