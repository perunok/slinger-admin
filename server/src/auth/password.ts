import argon2 from "argon2";

// OWASP-recommended argon2id parameters (m=19 MiB, t=2, p=1).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Verify against a throwaway hash so unknown-email and wrong-password logins cost the same. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("slinger-dummy-password");
  await verifyPassword(await dummyHash, password);
}
