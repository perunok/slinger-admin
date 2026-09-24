import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiYaml } from "../src/openapi.js";

const out = fileURLToPath(new URL("../openapi.yaml", import.meta.url));
writeFileSync(out, await buildOpenApiYaml());
console.log(`wrote ${out}`);
process.exit(0);
