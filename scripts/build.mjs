import { chmod, copyFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = process.argv[2];
const gateways = {
  dev: "https://back-wayline-gateway-dev.wayline-cc4.workers.dev",
  prod: "https://back-wayline-gateway-prod.wayline-cc4.workers.dev",
};

if (!(environment in gateways)) {
  console.error("usage: node scripts/build.mjs <dev|prod>");
  process.exit(2);
}

const packageJSON = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const outputDirectory = resolve(root, "dist", environment);
const output = resolve(outputDirectory, "index.js");
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(root, "src/index.ts")],
  outfile: output,
  bundle: true,
  external: ["commander"],
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __WAYLINE_API_URL__: JSON.stringify(gateways[environment]),
    __WAYLINE_BUILD_ENV__: JSON.stringify(environment),
    __WAYLINE_VERSION__: JSON.stringify(packageJSON.version),
  },
});
await chmod(output, 0o755);

if (environment === "prod") {
  await copyFile(output, resolve(root, "dist", "index.js"));
  await chmod(resolve(root, "dist", "index.js"), 0o755);
}
