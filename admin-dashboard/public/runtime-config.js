// Placeholder. The Slinger server answers /runtime-config.js itself with:
//   window.__SLINGER_API_BASE_URL__ = "/api";
// (the dashboard is served from the same origin as the API). The Vite dev server serves this file instead, and dev builds
// fall back to VITE_API_BASE_URL or /api. If a production build still sees the placeholder, it shows a configuration error.
