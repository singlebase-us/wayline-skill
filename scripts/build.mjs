import { chmod, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJSON = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const outputDirectory = resolve(root, "dist");
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
    __WAYLINE_VERSION__: JSON.stringify(packageJSON.version),
  },
});
await chmod(output, 0o755);
