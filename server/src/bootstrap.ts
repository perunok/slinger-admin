import { z } from "zod";
import { prisma as defaultPrisma } from "./db.js";
import { hashPassword } from "./auth/password.js";
import { newId } from "./lib/ids.js";
import type { PrismaClient } from "@prisma/client";

const WEAK_PASSWORDS = new Set([
  "admin",
  "administrator",
  "password",
  "changeme",
  "change-me",
  "change-me-in-production",
  "slinger",
  "12345678",
  "123456789012"
]);

const bootstrapEntry = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(256),
    display_name: z.string().trim().min(1).max(100),
    platform_role: z.enum(["super_admin", "platform_admin"])
  })
  .strict(); // unknown keys (e.g. the legacy `username`) are an error, not silently ignored

const bootstrapSchema = z.array(bootstrapEntry).max(20);

export type BootstrapAdmin = z.infer<typeof bootstrapEntry>;

/**
 * Parses SLINGER_ADMIN_BOOTSTRAP: a JSON array of
 * `{ email, password, display_name, platform_role }`. Throws an Error with an operator-readable message.
 * Never echoes password values.
 */
export function parseBootstrapAdmins(raw: string | undefined, opts: { isProduction: boolean }): BootstrapAdmin[] {
  if (raw === undefined || raw.trim() === "") return [];
  const hint =
    'Expected a JSON array like [{"email":"admin@example.com","password":"<12+ chars>","display_name":"Admin","platform_role":"super_admin"}].';
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`SLINGER_ADMIN_BOOTSTRAP is not valid JSON. ${hint}`);
  }
  const res = bootstrapSchema.safeParse(json);
  if (!res.success) {
    const lines = res.error.issues.map((i) => {
      const at = i.path.length ? `[${i.path.join(".")}]` : "";
      // Do not include received values (could be passwords); zod messages only describe shapes.
      return `${at} ${i.message}`.trim();
    });
    throw new Error(`SLINGER_ADMIN_BOOTSTRAP is invalid: ${lines.join("; ")}. ${hint}`);
  }
  const admins = res.data;
  const supers = admins.filter((a) => a.platform_role === "super_admin");
  if (supers.length > 1) throw new Error("SLINGER_ADMIN_BOOTSTRAP may contain at most one super_admin.");
  const emails = new Set(admins.map((a) => a.email));
  if (emails.size !== admins.length) throw new Error("SLINGER_ADMIN_BOOTSTRAP contains duplicate emails.");
  if (opts.isProduction) {
    for (const a of admins) {
      if (a.password.length < 12 || WEAK_PASSWORDS.has(a.password.toLowerCase()) || /change-?me/i.test(a.password)) {
        throw new Error(
          `SLINGER_ADMIN_BOOTSTRAP: password for ${a.email} is too weak for production (min 12 chars, no default/placeholder values).`
        );
      }
    }
  }
  return admins;
}

/**
 * Creates any bootstrap admins that do not exist yet. Existing accounts are never modified
 * (so a changed password in env does not silently reset a live account). Returns created emails.
 */
export async function applyBootstrap(
  admins: BootstrapAdmin[],
  db: PrismaClient = defaultPrisma
): Promise<string[]> {
  const created: string[] = [];
  for (const a of admins) {
    const existing = await db.user.findUnique({ where: { email: a.email } });
    if (existing) continue;
    const passwordHash = await hashPassword(a.password);
    try {
      await db.user.create({
        data: {
          id: newId(),
          email: a.email,
          displayName: a.display_name,
          passwordHash,
          platformRole: a.platform_role
        }
      });
      created.push(a.email);
    } catch (err) {
      // Unique violation = another replica created it concurrently; fine.
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }
  return created;
}
