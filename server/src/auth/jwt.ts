import { SignJWT, jwtVerify } from "jose";
import crypto from "node:crypto";

const ISSUER = "slinger-cloud-api";
export const AUDIENCE_API = "slinger-cloud-api";
export const AUDIENCE_REALTIME = "slinger-realtime";
export const AUDIENCE_COLLAB = "slinger-collab";

export type AccessTokenClaims = {
  sub: string;
  platform_role: string;
};

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(secret: string, claims: AccessTokenClaims, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ platform_role: claims.platform_role, typ_: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_API)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .setJti(crypto.randomUUID())
    .sign(key(secret));
}

/** Throws on any problem (bad signature, wrong audience, expired, wrong algorithm). */
export async function verifyAccessToken(secret: string, token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: ISSUER,
    audience: AUDIENCE_API,
    algorithms: ["HS256"]
  });
  if (payload.typ_ !== "access" || typeof payload.sub !== "string") throw new Error("not an access token");
  return { sub: payload.sub, platform_role: String(payload.platform_role) };
}

/** Thin signed-token issuer for the (out of scope) realtime/collab services. */
export async function signScopedToken(
  secret: string,
  audience: typeof AUDIENCE_REALTIME | typeof AUDIENCE_COLLAB,
  subject: string,
  ttlSeconds: number,
  claims: Record<string, unknown>
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .setJti(crypto.randomUUID())
    .sign(key(secret));
}
