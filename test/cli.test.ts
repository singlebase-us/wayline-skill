import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { UserAuth } from "../src/auth.js";
import { createProgram, USER_TOOLS } from "../src/commands.js";
import { CredentialStore } from "../src/credentials.js";
import { ApiError, ToolError } from "../src/errors.js";
import { HttpClient, ToolRequest } from "../src/http.js";
import { readTaskGraphVersion } from "../src/validation.js";

const ORGANIZATION = "10000000-0000-4000-8000-000000000001";
const REQUEST = "20000000-0000-4000-8000-000000000001";

test("local argument validation errors stay human-readable", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "organization",
    "get",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "error: --organization-id is required\n");
});

test("API failures remain structured tool errors", async () => {
  const runtime = fakeRuntime(async () => {
    throw new ApiError(503, "temporarily_unavailable", "try again later", "/organizations", undefined, "server-id");
  });

  await assert.rejects(
    () => createProgram(runtime).parseAsync([
      "node", "wayline-cli", "organization", "get", "--organization-id", ORGANIZATION,
    ]),
    (error) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.requestId, "server-id");
      assert.deepEqual(error.body, {
        code: "temporarily_unavailable",
        message: "try again later",
        retryable: true,
        details: { path: "/organizations" },
      });
      return true;
    },
  );
});

test("help is hierarchical and does not expose Admin commands", () => {
  const output: string[] = [];
  const program = createProgram(fakeRuntime());
  program.configureOutput({ writeOut: (value) => output.push(value), writeErr: (value) => output.push(value) });
  program.exitOverride();
  assert.throws(() => program.parse(["node", "wayline-cli", "--help"]));
  const help = output.join("");
  assert.match(help, /Commands:/);
  assert.match(help, /delivery-request/);
  assert.doesNotMatch(help, /Admin User|set-status|task-execution update/);
});

test("all advertised tools have registered commands", () => {
  const program = createProgram(fakeRuntime());
  for (const tool of USER_TOOLS) {
    if (tool === "capabilities") continue;
    const [group, action] = tool.split(" ");
    const groupCommand = program.commands.find((command) => command.name() === group);
    assert.ok(groupCommand, group);
    assert.ok(groupCommand.commands.some((command) => command.name() === action), tool);
  }
});

test("delivery request context maps to the organization-bounded User API", async () => {
  let captured: ToolRequest | undefined;
  const runtime = fakeRuntime(async (request) => { captured = request; return { data: { id: REQUEST }, requestId: "server-id" }; });
  const output = await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "delivery-request", "context",
    "--organization-id", ORGANIZATION, "--delivery-request-id", REQUEST,
  ]));
  assert.equal(captured?.method, "GET");
  assert.equal(captured?.path, `/hub/api/v1/delivery-requests/${REQUEST}/context`);
  assert.equal(captured?.query?.get("organization_id"), ORGANIZATION);
  assert.deepEqual(JSON.parse(output), {
    schema: "wayline-cli-result/v1", ok: true, data: { id: REQUEST },
    meta: { request_id: "server-id", warnings: [] },
  });
});

test("delivery request content updates use the User API with an organization boundary", async () => {
  let captured: ToolRequest | undefined;
  const runtime = fakeRuntime(async (request) => {
    captured = request;
    return { data: { id: REQUEST, lock_version: 8 }, requestId: "server-id" };
  });

  await captureStdout(() =>
    createProgram(runtime).parseAsync([
      "node",
      "wayline-cli",
      "delivery-request",
      "update-content",
      "--organization-id",
      ORGANIZATION,
      "--delivery-request-id",
      REQUEST,
      "--expected-lock-version",
      "7",
      "--title",
      "Renamed request",
      "--description",
      "Updated requirement",
    ]),
  );

  assert.equal(captured?.method, "PATCH");
  assert.equal(
    captured?.path,
    `/hub/api/v1/delivery-requests/${REQUEST}/content`,
  );
  assert.equal(captured?.query?.get("organization_id"), ORGANIZATION);
  assert.deepEqual(captured?.body, {
    expected_lock_version: 7,
    title: "Renamed request",
    description: "Updated requirement",
  });
});

test("offline version submission uses expected-current CAS without an idempotency header", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-submit-test-"));
  const input = join(root, "version.json");
  await writeFile(input, JSON.stringify({
    schema_version: "task-graph-version/v1", graph: { nodes: [], edges: [] },
  }));
  let captured: ToolRequest | undefined;
  const runtime = fakeRuntime(async (request) => {
    captured = request;
    return { data: { id: REQUEST }, requestId: "server-id" };
  });
  await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "version", "submit",
    "--organization-id", ORGANIZATION,
    "--delivery-request-id", REQUEST,
    "--expected-current-version-id", REQUEST,
    "--input", input,
  ]));
  assert.equal(captured?.path, `/hub/api/v1/delivery-requests/${REQUEST}/version-submissions`);
  assert.equal(captured?.query?.get("organization_id"), ORGANIZATION);
  assert.equal(captured?.headers?.["Idempotency-Key"], undefined);
  assert.deepEqual(captured?.body, {
    expected_current_version_id: REQUEST,
    source: {
      type: "payload",
      payload: { schema_version: "task-graph-version/v1", graph: { nodes: [], edges: [] } },
    },
  });
});

test("credentials are isolated in private ~/.wayline-style files", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-user-test-"));
  const store = new CredentialStore(root);
  await store.set("https://api.example", { refresh_token: "refresh", access_token: "access" });
  const directory = await stat(join(root, "credentials"));
  assert.equal(directory.mode & 0o777, 0o700);
  const names = (await import("node:fs/promises")).readdir(join(root, "credentials"));
  const [name] = await names;
  assert.match(name, /^user-[0-9a-f]{16}\.json$/);
  const file = await stat(join(root, "credentials", name));
  assert.equal(file.mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(join(root, "credentials", name), "utf8"), /api\.example/);
});

test("user access refreshes after one third and persists rotated refresh token", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-refresh-test-"));
  const store = new CredentialStore(root);
  const now = new Date("2026-10-22T00:06:00.000Z");
  await store.set("https://api.example", {
    refresh_token: "old-refresh", access_token: "old-access",
    access_obtained_at: "2026-10-22T00:00:00.000Z", access_expires_at: "2026-10-22T00:15:00.000Z",
    refresh_expires_at: "2026-11-22T00:00:00.000Z",
  });
  const client = {
    request: async () => ({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 900, refresh_expires_in: 2_592_000 }),
  } as unknown as HttpClient;
  const auth = new UserAuth(client, "https://api.example", store, () => now);
  const access = await auth.accessForOperation(true);
  assert.equal(access.credential.access_token, "old-access");
  await access.refresh;
  assert.equal((await store.get("https://api.example")).refresh_token, "new-refresh");
});

test("credential refresh lock serializes concurrent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-lock-test-"));
  const store = new CredentialStore(root);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const first = store.withLock("https://api.example", async () => {
    order.push("first-enter");
    await blocked;
    order.push("first-exit");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = store.withLock("https://api.example", async () => { order.push("second-enter"); });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(order, ["first-enter"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

test("device login opens the complete confirmation URL without asking for a code", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-device-login-test-"));
  const writes: string[] = [];
  const opened: string[] = [];
  const client = deviceLoginClient();
  const auth = new UserAuth(
    client,
    "https://api.example",
    new CredentialStore(root),
    () => new Date("2026-10-23T00:00:00.000Z"),
    async (url) => { opened.push(url); },
    async () => undefined,
  );

  await auth.login("Workstation", false, (value) => writes.push(value));

  assert.deepEqual(opened, ["https://app.example.com/cli/activate?user_code=ABCD-EFGH"]);
  assert.deepEqual(writes, ["Opening your browser to confirm this Wayline CLI login..."]);
  assert.doesNotMatch(writes.join("\n"), /enter code/i);
});

test("no-browser device login prints the complete URL and keeps the user code as fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-device-no-browser-test-"));
  const writes: string[] = [];
  let opened = false;
  const auth = new UserAuth(
    deviceLoginClient(),
    "https://api.example",
    new CredentialStore(root),
    () => new Date("2026-10-23T00:00:00.000Z"),
    async () => { opened = true; },
    async () => undefined,
  );

  await auth.login("Workstation", true, (value) => writes.push(value));

  assert.equal(opened, false);
  assert.equal(writes[1], "https://app.example.com/cli/activate?user_code=ABCD-EFGH");
  assert.match(writes[2] ?? "", /enter code: ABCD-EFGH/);
});

test("task graph input enforces the version protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-graph-test-"));
  const path = join(root, "graph.json");
  await (await import("node:fs/promises")).writeFile(path, JSON.stringify({
    schema_version: "task-graph-version/v1",
    graph: {
      nodes: [{ ref: "n_TASK001", type: "task", attributes: { title: "T", description: "D", estimated_minutes: 60, estimate_source: "ai" } }],
      edges: [],
    },
  }));
  const value = await readTaskGraphVersion(path);
  assert.equal(value.schema_version, "task-graph-version/v1");
});

function fakeRuntime(callTool: (request: ToolRequest) => Promise<{ data: unknown; requestId: string }> = async () => ({ data: {}, requestId: "id" })) {
  return {
    client: { callTool } as unknown as HttpClient,
    auth: { accessForOperation: async () => ({ credential: { refresh_token: "r", access_token: "a" }, refresh: Promise.resolve() }) } as unknown as UserAuth,
  };
}

function deviceLoginClient(): HttpClient {
  return {
    request: async (_method: string, path: string) => {
      if (path.endsWith("/device-authorizations")) {
        return {
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.example.com/cli/activate",
          verification_uri_complete: "https://app.example.com/cli/activate?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        };
      }
      return {
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 900,
        refresh_expires_in: 2_592_000,
      };
    },
  } as unknown as HttpClient;
}

async function captureStdout(operation: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let value = "";
  process.stdout.write = ((chunk: string | Uint8Array) => { value += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { await operation(); } finally { process.stdout.write = original; }
  return value.trim();
}
