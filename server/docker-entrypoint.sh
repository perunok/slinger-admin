#!/bin/sh
# Applies pending Prisma migrations, then starts the server (exec so it receives SIGTERM directly).
set -eu
if [ "${SLINGER_SKIP_MIGRATIONS:-0}" != "1" ]; then
  echo "applying database migrations..."
  ./node_modules/.bin/prisma migrate deploy
fi
exec "$@"
