import { buildApp } from "./app.js";
import { applyBootstrap } from "./bootstrap.js";
import { ConfigError, loadConfig } from "./config.js";
import { prisma } from "./db.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message); // safe: ConfigError never contains secret values
      process.exit(1);
    }
    throw err;
  }

  const app = await buildApp({ config });

  // Cannot start without the database: fail fast with a clear message rather than serving 500s.
  try {
    await prisma.$connect();
  } catch (err) {
    app.log.error({ err }, "cannot connect to the database (check DATABASE_URL and that migrations were applied)");
    process.exit(1);
  }

  const created = await applyBootstrap(config.bootstrapAdmins);
  for (const email of created) app.log.info({ email }, "bootstrap admin created");
  if (config.bootstrapAdmins.length === 0 && (await prisma.user.count()) === 0) {
    app.log.warn("no users exist and SLINGER_ADMIN_BOOTSTRAP is not set: nobody can sign in");
  }

  // Housekeeping: drop expired sessions / refresh tokens / device flows hourly.
  const sweep = setInterval(() => {
    const now = new Date();
    void Promise.all([
      prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
      prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
      prisma.deviceFlow.deleteMany({ where: { expiresAt: { lt: now } } }),
      app.rateLimitStore.sweep?.()
    ]).catch((err) => app.log.warn({ err }, "housekeeping sweep failed"));
  }, 60 * 60 * 1000);
  sweep.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      app.log.error("graceful shutdown timed out, exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      clearInterval(sweep);
      await app.close(); // stops accepting, waits for in-flight requests
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error("fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
