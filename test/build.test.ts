import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("a dev build activates the npm-linked CLI entrypoint", async () => {
  const root = process.cwd();
  const entrypoint = join(root, "dist", "index.js");
  const previous = await readFile(entrypoint);
  const previousMode = (await stat(entrypoint)).mode;
  try {
    await execute(process.execPath, [join(root, "scripts", "build.mjs"), "dev"], { cwd: root });
    const { stdout } = await execute(process.execPath, [entrypoint, "capabilities"], { cwd: root });
    const result = JSON.parse(stdout) as { data?: { build_environment?: string } };
    assert.equal(result.data?.build_environment, "dev");

    await execute(process.execPath, [join(root, "scripts", "build.mjs"), "prod"], { cwd: root });
    const prod = await execute(process.execPath, [entrypoint, "capabilities"], { cwd: root });
    const prodResult = JSON.parse(prod.stdout) as { data?: { build_environment?: string } };
    assert.equal(prodResult.data?.build_environment, "prod");
  } finally {
    await writeFile(entrypoint, previous);
    await chmod(entrypoint, previousMode);
  }
});
