#!/bin/sh
# Writes dist/runtime-config.js from the container environment, then serves dist/.
# VITE_API_BASE_URL is the URL prefix in front of "/v1" (default "/api", which the
# bundled Caddy proxy strips before forwarding to the API).
set -eu
cd "$(dirname "$0")"

API_BASE_URL="${VITE_API_BASE_URL:-/api}"
export API_BASE_URL

node -e '
const fs = require("fs");
const v = process.env.API_BASE_URL;
fs.writeFileSync("dist/runtime-config.js",
  "window.__SLINGER_API_BASE_URL__ = " + JSON.stringify(v) + ";\n");
'
echo "slinger-admin-dashboard: API base URL = ${API_BASE_URL}"
exec npm run preview
