#!/bin/sh
set -eu
node <<'EOF'
const fs = require('fs');
const baseUrl = process.env.VITE_API_BASE_URL || '/api';
fs.writeFileSync('dist/runtime-config.js', `window.__SLINGER_API_BASE_URL__ = ${JSON.stringify(baseUrl)};
`);
EOF
exec npm run preview
