import type { Prisma, PrismaClient, User } from "@prisma/client";
import type { AppConfig } from "../config.js";
import { newId } from "../lib/ids.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { signAccessToken } from "./jwt.js";
import { AppError } from "../lib/errors.js";

type Tx = PrismaClient | Prisma.TransactionClient;

export type PublicUser = {
  id: string;
  email: string;
  display_name: string;
  platform_role: string;
};

export function publicUser(u: Pick<User, "id" | "email" | "displayName" | "platformRole">): PublicUser {
  return { id: u.id, email: u.email, display_name: u.displayName, platform_role: u.platformRole };
}

export type TokenPair = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
};

export async function issueTokenPair(cfg: AppConfig, db: Tx, user: User): Promise<TokenPair> {
  const refresh = randomToken(32);
  await db.refreshToken.create({
    data: {
      id: newId(),
      userId: user.id,
      tokenHash: sha256Hex(refresh),
      expiresAt: new Date(Date.now() + cfg.refreshTokenTtlSeconds * 1000)
    }
  });
  const access = await signAccessToken(
    cfg.signingSecret,
    { sub: user.id, platform_role: user.platformRole },
    cfg.accessTokenTtlSeconds
  );
  return { access_token: access, refresh_token: refresh, expires_in: cfg.accessTokenTtlSeconds, token_type: "Bearer" };
}

/**
 * Rotates a refresh token. Presenting an already-revoked token is treated as theft:
 * every refresh token of that user is revoked.
 */
export async function rotateRefreshToken(cfg: AppConfig, prisma: PrismaClient, presented: string): Promise<TokenPair> {
  const hash = sha256Hex(presented);
  const invalid = () => new AppError("unauthenticated", "invalid refresh token");
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
  if (!row) throw invalid();
  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw invalid();
  }
  if (row.expiresAt <= new Date() || row.user.disabledAt) throw invalid();
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    if (claimed.count !== 1) throw invalid(); // lost a race with a concurrent refresh
    return issueTokenPair(cfg, tx, row.user);
  });
}

export async function revokeAllUserCredentials(db: Tx, userId: string): Promise<void> {
  await db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  await db.session.deleteMany({ where: { userId } });
}
