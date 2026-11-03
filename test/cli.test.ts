import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Command } from "commander";
import { UserAuth } from "../src/auth.js";
import { createProgram, USER_TOOLS } from "../src/commands.js";
import { CredentialStore } from "../src/credentials.js";
import { ApiError, CredentialsNotFoundError, OAuthError, ToolError } from "../src/errors.js";
import { HttpClient, ToolRequest } from "../src/http.js";
import { OrganizationBindingStore, projectScope } from "../src/organization-binding.js";
import { readTaskGraphVersion } from "../src/validation.js";

const ORGANIZATION = "10000000-0000-4000-8000-000000000001";
const REQUEST = "20000000-0000-4000-8000-000000000001";
const VERSION = "40000000-0000-4000-8000-000000000001";

test("local argument validation errors stay human-readable", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "organization",
    "get",
    "--organization-id",
    "not-a-uuid",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "error: --organization-id must be a UUID\n");
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

test("request-scoped commands locate the delivery request by UUID alone", async () => {
  const requests: ToolRequest[] = [];
  const runtime = fakeRuntime(async (request) => { requests.push(request); return { data: { id: REQUEST }, requestId: "server-id" }; });
  const output = await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "delivery-request", "context", "--delivery-request-id", REQUEST,
  ]));
  // No organization lookup, binding, or organization_id: the request determines its organization.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].path, `/hub/api/v1/delivery-requests/${REQUEST}/context`);
  assert.equal(requests[0].query?.get("organization_id") ?? null, null);
  assert.deepEqual(JSON.parse(output), {
    schema: "wayline-cli-result/v1", ok: true, data: { id: REQUEST },
    meta: { request_id: "server-id", warnings: [] },
  });

  const program = createProgram(runtime);
  program.commands.forEach(function quiet(command: Command): void {
    command.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    command.commands.forEach(quiet);
  });
  await assert.rejects(
    () => program.parseAsync([
      "node", "wayline-cli", "delivery-request", "get",
      "--organization-id", ORGANIZATION, "--delivery-request-id", REQUEST,
    ]),
    /unknown option '--organization-id'/,
  );
});

test("task execution reads project the current version unless a version is named", async () => {
  const requests: ToolRequest[] = [];
  const runtime = fakeRuntime(async (request) => {
    requests.push(request);
    return { data: { nodes: [] }, requestId: "server-id" };
  });
  await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "task-execution", "get", "--delivery-request-id", REQUEST,
  ]));
  await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "task-execution", "get", "--delivery-request-id", REQUEST,
    "--version-id", VERSION,
  ]));
  assert.equal(requests[0].path, `/hub/api/v1/delivery-requests/${REQUEST}/task-execution`);
  assert.equal(requests[0].query?.get("version_id"), null);
  assert.equal(requests[1].query?.get("version_id"), VERSION);
});

test("service point reads map to the read-only User API", async () => {
  const requests: ToolRequest[] = [];
  const runtime = fakeRuntime(async (request) => {
    requests.push(request);
    return { data: {}, requestId: "server-id" };
  });
  const run = (...args: string[]) => captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "service-point", ...args,
  ]));
  await run("account", "--organization-id", ORGANIZATION);
  await run("entries", "--organization-id", ORGANIZATION, "--kind", "grant", "--limit", "5");
  await run("usage", "--delivery-request-id", REQUEST);
  await run("deductions", "--delivery-request-id", REQUEST);
  await run("deductions", "--delivery-request-id", REQUEST, "--node-ref", "n_TASK001");

  assert.ok(requests.every((request) => request.method === "GET"));
  assert.equal(requests[0].path, `/hub/api/v1/organizations/${ORGANIZATION}/service-point-account`);
  assert.equal(requests[1].path, `/hub/api/v1/organizations/${ORGANIZATION}/service-point-entries`);
  assert.equal(requests[1].query?.get("kind"), "grant");
  assert.equal(requests[1].query?.get("limit"), "5");
  assert.equal(requests[2].path, `/hub/api/v1/delivery-requests/${REQUEST}/service-point-usage`);
  assert.equal(requests[3].path, `/hub/api/v1/delivery-requests/${REQUEST}/deductions`);
  assert.equal(requests[4].path, `/hub/api/v1/delivery-requests/${REQUEST}/task-graph/nodes/n_TASK001/deductions`);
  for (const request of requests.slice(2)) assert.equal(request.query?.get("organization_id") ?? null, null);
});

test("service point entries reject unknown kinds before calling the Hub", async () => {
  let called = false;
  const runtime = fakeRuntime(async () => { called = true; return { data: {}, requestId: "id" }; });
  await assert.rejects(
    () => createProgram(runtime).parseAsync([
      "node", "wayline-cli", "service-point", "entries", "--organization-id", ORGANIZATION, "--kind", "refund",
    ]),
    /--kind must be one of: grant, adjustment, task_deduction/,
  );
  assert.equal(called, false);
});

test("delivery request content updates use the User API by UUID", async () => {
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
  assert.equal(captured?.query?.get("organization_id") ?? null, null);
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
    "--delivery-request-id", REQUEST,
    "--expected-current-version-id", REQUEST,
    "--input", input,
  ]));
  assert.equal(captured?.path, `/hub/api/v1/delivery-requests/${REQUEST}/version-submissions`);
  assert.equal(captured?.headers?.["Idempotency-Key"], undefined);
  assert.deepEqual(captured?.body, {
    expected_current_version_id: REQUEST,
    source: {
      type: "payload",
      payload: { schema_version: "task-graph-version/v1", graph: { nodes: [], edges: [] } },
    },
  });
});

test("organization bindings follow the project root and stay in private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-binding-store-test-"));
  const repository = join(root, "repo");
  const nested = join(repository, "src", "commands");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  assert.equal(projectScope(nested), repository);
  assert.equal(projectScope(join(root, "loose")), join(root, "loose"));

  const store = new OrganizationBindingStore(join(root, "home"));
  await store.set("https://api.example", repository, ORGANIZATION, "Wayline");
  const directory = join(root, "home", "organizations");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const [name] = await readdir(directory);
  assert.match(name, /^[0-9a-f]{16}\.json$/);
  assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(join(directory, name), "utf8"), /api\.example|repo/);

  const binding = await store.get("https://api.example", projectScope(nested));
  assert.equal(binding.organization_id, ORGANIZATION);
  assert.equal(binding.name, "Wayline");
  await store.set("https://other.example", repository, REQUEST, "Other");
  assert.equal((await store.get("https://api.example", repository)).organization_id, ORGANIZATION);
  assert.equal(await store.delete("https://api.example", repository), true);
  assert.equal(await store.delete("https://api.example", repository), false);
});

test("a directory binding supplies the organization and the meta reports its source", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-binding-runtime-test-"));
  const repository = join(root, "repo");
  await mkdir(join(repository, ".git"), { recursive: true });
  const bindings = new OrganizationBindingStore(join(root, "home"));
  const requests: ToolRequest[] = [];
  const runtime = fakeRuntime(async (request) => {
    requests.push(request);
    return { data: { id: REQUEST }, requestId: "server-id" };
  }, bindings);
  const previous = process.cwd();
  process.chdir(repository);
  try {
    const bound = await captureStdout(() => createProgram(runtime).parseAsync([
      "node", "wayline-cli", "organization", "use", "--organization-id", ORGANIZATION,
    ]));
    assert.match(bound, /"Wayline"/);
    assert.match(bound, new RegExp(ORGANIZATION));

    const output = await captureStdout(() => createProgram(runtime).parseAsync([
      "node", "wayline-cli", "task-group", "list",
    ]));
    assert.equal(requests[0].path, `/hub/api/v1/organizations/${ORGANIZATION}/task-groups`);
    assert.deepEqual(JSON.parse(output).meta, {
      request_id: "server-id", warnings: [], organization_id: ORGANIZATION, organization_source: "binding",
    });

    const current = await captureStdout(() => createProgram(runtime).parseAsync(["node", "wayline-cli", "organization", "current"]));
    assert.match(current, new RegExp(ORGANIZATION));

    const overridden = await captureStdout(() => createProgram(runtime).parseAsync([
      "node", "wayline-cli", "task-group", "list", "--organization-id", REQUEST,
    ]));
    assert.equal(requests[1].path, `/hub/api/v1/organizations/${REQUEST}/task-groups`);
    assert.equal(JSON.parse(overridden).meta.organization_source, "flag");

    await captureStdout(() => createProgram(runtime).parseAsync(["node", "wayline-cli", "organization", "unset"]));
    await assert.rejects(
      () => createProgram(runtime).parseAsync([
        "node", "wayline-cli", "task-group", "list",
      ]),
      /no organization is bound/,
    );
  } finally {
    process.chdir(previous);
  }
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

test("--no-wait login prints the link and leaves the approval pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-no-wait-login-test-"));
  const state = { approved: false, authorizations: 0 };
  const store = new CredentialStore(root);
  const client = deviceFlowClient(state);
  let opened = 0;
  const auth = new UserAuth(
    client,
    "https://api.example",
    store,
    () => new Date("2026-10-23T00:00:00.000Z"),
    async () => { opened++; },
    async () => { throw new Error("a non-blocking login must not wait"); },
  );
  const runtime = { client, auth, bindings: new OrganizationBindingStore(join(root, "bindings")) };

  const started = await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "auth", "login", "--no-wait", "--device-name", "Workstation",
  ]));
  assert.match(started, /https:\/\/app\.example\.com\/cli\/activate\?user_code=ABCD-EFGH/);
  assert.match(started, /enter code: ABCD-EFGH/);
  assert.match(started, /Run wayline-cli auth status after you approve/);
  assert.equal(opened, 0);
  assert.equal(state.authorizations, 1);

  const pending = await store.getPending("https://api.example", new Date("2026-10-23T00:01:00.000Z"));
  assert.equal(pending?.device_code, "device-1");
  const files = await readdir(join(root, "credentials"));
  assert.ok(files.some((name) => /^user-pending-[0-9a-f]{16}\.json$/.test(name)));
  await assert.rejects(() => store.get("https://api.example"), CredentialsNotFoundError);

  const resumed = await captureStdout(() => createProgram(runtime).parseAsync(["node", "wayline-cli", "auth", "login", "--no-wait"]));
  assert.equal(state.authorizations, 1);
  assert.match(resumed, /already waiting for approval; reuse the link/);
  assert.match(resumed, /https:\/\/app\.example\.com\/cli\/activate\?user_code=ABCD-EFGH/);

  const waiting = await captureStdout(() => createProgram(runtime).parseAsync(["node", "wayline-cli", "auth", "status"]));
  assert.match(waiting, /Login is waiting for browser approval/);
  await assert.rejects(() => store.get("https://api.example"), CredentialsNotFoundError);

  state.approved = true;
  const finished = await captureStdout(() => createProgram(runtime).parseAsync(["node", "wayline-cli", "auth", "status"]));
  assert.match(finished, /Authenticated as Hub User \(Tester\)/);
  assert.equal((await store.get("https://api.example")).refresh_token, "refresh");
  assert.equal(await store.getPending("https://api.example", new Date("2026-10-23T00:02:00.000Z")), null);

  const signedIn = await captureStdout(() => createProgram(runtime).parseAsync(["node", "wayline-cli", "auth", "login", "--no-wait"]));
  assert.match(signedIn, /Already authenticated; nothing to do/);
  assert.doesNotMatch(signedIn, /user_code=/);
  assert.equal(state.authorizations, 1);
});

test("a denied device authorization drops the pending login so a fresh one can start", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-denied-login-test-"));
  const store = new CredentialStore(root);
  const auth = new UserAuth(
    deviceFlowClient({ approved: false, authorizations: 0 }, "access_denied"),
    "https://api.example",
    store,
    () => new Date("2026-10-23T00:00:00.000Z"),
  );
  await auth.startLogin("Workstation", true, () => undefined);
  assert.ok(await store.getPending("https://api.example", new Date("2026-10-23T00:01:00.000Z")));
  assert.equal(await auth.finishPendingLogin(), false);
  assert.equal(await store.getPending("https://api.example", new Date("2026-10-23T00:01:00.000Z")), null);
});

test("auth logout discards a pending login", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-logout-pending-test-"));
  const store = new CredentialStore(root);
  const auth = new UserAuth(
    deviceFlowClient({ approved: false, authorizations: 0 }),
    "https://api.example",
    store,
    () => new Date("2026-10-23T00:00:00.000Z"),
  );
  await auth.startLogin("Workstation", true, () => undefined);
  assert.ok(await store.getPending("https://api.example", new Date("2026-10-23T00:01:00.000Z")));
  assert.equal(await auth.logout(), "already");
  assert.equal(await store.getPending("https://api.example", new Date("2026-10-23T00:01:00.000Z")), null);
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

test("version check reports graph findings locally without calling the Hub", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-check-test-"));
  const input = join(root, "version.json");
  await writeFile(input, JSON.stringify(shortcutGraph()));
  const runtime = fakeRuntime(async () => assert.fail("version check must not call the Hub"));
  const output = JSON.parse(await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "version", "check", "--input", input,
  ])));
  assert.equal(output.ok, true);
  assert.equal(output.data.publishable, true);
  assert.deepEqual(output.data.warnings.map((finding: { refs: string[] }) => finding.refs), [["e_SHORTCUT"]]);
  assert.equal(output.meta.organization_id, undefined);
});

test("version submit echoes graph findings in meta warnings without blocking", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-submit-warn-test-"));
  const input = join(root, "version.json");
  await writeFile(input, JSON.stringify(shortcutGraph()));
  let submitted = false;
  const runtime = fakeRuntime(async () => { submitted = true; return { data: { id: VERSION }, requestId: "server-id" }; });
  const output = JSON.parse(await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "version", "submit",
    "--delivery-request-id", REQUEST,
    "--expected-current-version-id", VERSION, "--input", input,
  ])));
  assert.equal(submitted, true);
  assert.equal(output.meta.warnings.length, 1);
  assert.match(output.meta.warnings[0], /^redundant_edge: edge e_SHORTCUT links n_STAGE001 directly to the summary/);
});

test("version get --output writes an editable payload file and keeps it out of stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-get-output-test-"));
  const file = join(root, "version.json");
  const payload = shortcutGraph();
  const runtime = fakeRuntime(async () => ({
    data: { id: VERSION, content_hash: "hash", version_payload: payload }, requestId: "server-id",
  }));
  const output = JSON.parse(await captureStdout(() => createProgram(runtime).parseAsync([
    "node", "wayline-cli", "version", "get",
    "--delivery-request-id", REQUEST,
    "--version-id", VERSION, "--output", file,
  ])));
  assert.deepEqual(output.data, { id: VERSION, content_hash: "hash", payload_file: file });
  assert.equal(await readFile(file, "utf8"), `${JSON.stringify(payload, null, 2)}\n`);
  assert.deepEqual(await readTaskGraphVersion(file), payload);
});

test("an unbound directory falls back to the only organization membership without binding it", async () => {
  const root = await mkdtemp(join(tmpdir(), "wayline-single-membership-test-"));
  const repository = join(root, "repo");
  await mkdir(join(repository, ".git"), { recursive: true });
  const bindings = new OrganizationBindingStore(join(root, "home"));
  let memberships = [{ id: ORGANIZATION }];
  const requests: ToolRequest[] = [];
  const runtime = fakeRuntime(async (request) => {
    requests.push(request);
    if (request.path === "/hub/api/v1/organizations") return { data: { items: memberships, next_cursor: null }, requestId: "list-id" };
    return { data: { id: REQUEST }, requestId: "server-id" };
  }, bindings);
  const previous = process.cwd();
  process.chdir(repository);
  try {
    const output = JSON.parse(await captureStdout(() => createProgram(runtime).parseAsync([
      "node", "wayline-cli", "task-group", "list",
    ])));
    assert.equal(requests[0].query?.get("limit"), "2");
    assert.equal(requests[1].path, `/hub/api/v1/organizations/${ORGANIZATION}/task-groups`);
    assert.deepEqual(output.meta, {
      request_id: "server-id", warnings: [], organization_id: ORGANIZATION, organization_source: "single_membership",
    });
    await assert.rejects(() => bindings.get("https://back.wayline.studio", repository), /no organization binding/);

    memberships = [{ id: ORGANIZATION }, { id: REQUEST }];
    await assert.rejects(
      () => createProgram(runtime).parseAsync([
        "node", "wayline-cli", "task-group", "list",
      ]),
      /does not belong to exactly one/,
    );
  } finally {
    process.chdir(previous);
  }
});

function shortcutGraph() {
  const task = (ref: string) => ({
    ref, type: "task", attributes: { title: ref, description: "D", estimated_minutes: 60, estimate_source: "ai" },
  });
  return {
    schema_version: "task-graph-version/v1",
    graph: {
      nodes: [task("n_STAGE001"), task("n_STAGE002"), { ref: "n_SUMMARY1", type: "summary", attributes: { title: "Goal" } }],
      edges: [
        { ref: "e_STAGE001", source: "n_STAGE001", target: "n_STAGE002" },
        { ref: "e_STAGE002", source: "n_STAGE002", target: "n_SUMMARY1" },
        { ref: "e_SHORTCUT", source: "n_STAGE001", target: "n_SUMMARY1" },
      ],
    },
  };
}

function fakeRuntime(
  callTool:(request: ToolRequest) => Promise<{ data: unknown; requestId: string }> = async () => ({ data: {}, requestId: "id" }),
  bindings: OrganizationBindingStore = new OrganizationBindingStore(join(tmpdir(), "wayline-cli-test-no-bindings")),
) {
  return {
    client: { callTool, request: async () => ({ id: ORGANIZATION, name: "Wayline" }) } as unknown as HttpClient,
    auth: { accessForOperation: async () => ({ credential: { refresh_token: "r", access_token: "a" }, refresh: Promise.resolve() }) } as unknown as UserAuth,
    bindings,
  };
}

function deviceFlowClient(state: { approved: boolean; authorizations: number }, denyCode = ""): HttpClient {
  return {
    request: async (_method: string, path: string) => {
      if (path.endsWith("/device-authorizations")) {
        state.authorizations++;
        return {
          device_code: `device-${state.authorizations}`,
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.example.com/cli/activate",
          verification_uri_complete: "https://app.example.com/cli/activate?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        };
      }
      if (path.endsWith("/cli/token")) {
        if (denyCode) throw new OAuthError(denyCode);
        if (!state.approved) throw new OAuthError("authorization_pending");
        return {
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 2_592_000,
        };
      }
      return {
        id: "session-1",
        client_id: "wayline-cli",
        status: "active",
        display_name: "Tester",
        absolute_expires_at: "2026-10-24T00:00:00.000Z",
        idle_expires_at: "2026-10-23T01:00:00.000Z",
        last_used_at: "2026-10-23T00:00:00.000Z",
        created_at: "2026-10-23T00:00:00.000Z",
      };
    },
  } as unknown as HttpClient;
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
