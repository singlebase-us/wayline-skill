import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("the built CLI resolves its API base URL at runtime", async () => {
  const root = process.cwd();
  const entrypoint = join(root, "dist", "index.js");
  await execute(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root });

  const defaultEnvironment = { ...process.env };
  delete defaultEnvironment.WAYLINE_CLI_BASE_URL;
  const defaultRun = await execute(process.execPath, [entrypoint, "capabilities"], {
    cwd: root,
    env: defaultEnvironment,
  });
  const defaultResult = JSON.parse(defaultRun.stdout) as { data?: { api_base_url?: string; build_environment?: string } };
  assert.equal(defaultResult.data?.api_base_url, "https://back.wayline.studio");
  assert.equal(defaultResult.data?.build_environment, undefined);

  const overriddenRun = await execute(process.execPath, [entrypoint, "capabilities"], {
    cwd: root,
    env: { ...process.env, WAYLINE_CLI_BASE_URL: "http://127.0.0.1:8787" },
  });
  const overriddenResult = JSON.parse(overriddenRun.stdout) as { data?: { api_base_url?: string } };
  assert.equal(overriddenResult.data?.api_base_url, "http://127.0.0.1:8787");

  const invalidRun = spawnSync(process.execPath, [entrypoint, "capabilities"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WAYLINE_CLI_BASE_URL: "not-a-url" },
  });
  assert.equal(invalidRun.status, 1);
  assert.equal(invalidRun.stdout, "");
  assert.equal(invalidRun.stderr, "error: invalid API URL \"not-a-url\"\n");
});
