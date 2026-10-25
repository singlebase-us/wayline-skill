import { Command } from "commander";
import { buildInfo } from "./build.js";
import { UserAuth, defaultDeviceName } from "./auth.js";
import { HttpClient, ToolRequest } from "./http.js";
import { TASK_GRAPH_VERSION_SCHEMA, ToolInvocation } from "./tool.js";
import {
  deliveryRequestStatuses,
  enumValue,
  nonNegativeInteger,
  optionalUUID,
  pageQuery,
  readTaskGraphVersion,
  required,
  requiredNodeRef,
  requiredUUID,
} from "./validation.js";

const PREFIX = "/hub/api/v1";

export const USER_TOOLS = [
  "capabilities",
  "organization list", "organization get",
  "task-group list", "task-group create", "task-group rename", "task-group delete",
  "delivery-request list", "delivery-request get", "delivery-request context",
  "delivery-request create", "delivery-request update-content", "delivery-request move",
  "version list", "version get", "version diff", "version submit",
  "change list", "change get", "change submit", "change approve",
  "change request-changes", "change replace-candidate", "change withdraw",
  "task-graph get", "task-execution get",
  "developer-profile list", "developer-profile get",
  "node-comment list",
] as const;

type Options = Record<string, unknown>;

export interface Runtime {
  client: HttpClient;
  auth: UserAuth;
}

export function createProgram(runtime: Runtime): Command {
  const program = new Command();
  program
    .name("wayline-cli")
    .version(buildInfo.version)
    .description("Wayline Agent CLI — authenticate as a Hub User and work with organizations, delivery requests, task graphs, versions, and approvals")
    .showHelpAfterError()
    .configureHelp({ helpWidth: 100 });

  registerAuth(program, runtime.auth);
  program.command("capabilities")
    .description("Show the CLI version, API base URL, schemas, and supported Agent tools")
    .action(toolAction(runtime, async (_options, invocation) => {
      invocation.localSuccess({
        binary: "wayline-cli",
        version: buildInfo.version,
        api_base_url: buildInfo.apiURL,
        result_schema: "wayline-cli-result/v1",
        task_graph_schema: TASK_GRAPH_VERSION_SCHEMA,
        tools: USER_TOOLS,
      });
    }));
  registerOrganization(program, runtime);
  registerTaskGroup(program, runtime);
  registerDeliveryRequest(program, runtime);
  registerVersion(program, runtime);
  registerChange(program, runtime);
  registerRequestRead(program, runtime, "task-graph", "Read the published task graph");
  registerTaskExecution(program, runtime);
  registerDeveloperProfile(program, runtime);
  registerNodeComment(program, runtime);
  return program;
}

function registerAuth(program: Command, auth: UserAuth): void {
  const command = program.command("auth").description("Authenticate and manage the local Hub User CLI session");
  command.command("login")
    .description("Start browser device authorization")
    .option("--device-name <name>", "Device name shown during approval", defaultDeviceName())
    .option("--no-browser", "Do not open the verification URL")
    .action(async (options: { deviceName: string; browser: boolean }) => {
      await auth.login(options.deviceName, options.browser === false, (value) => process.stdout.write(`${value}\n`));
      process.stdout.write("Authenticated as a Hub User.\n");
    });
  command.command("status")
    .description("Show the current Hub User authentication status")
    .action(async () => {
      const session = await auth.status();
      process.stdout.write(`Authenticated as Hub User (${session.display_name}). Session expires after inactivity at ${session.idle_expires_at}; absolute expiry ${session.absolute_expires_at}.\n`);
    });
  command.command("logout")
    .description("Revoke the current Hub User session and remove local credentials")
    .action(async () => {
      const result = await auth.logout();
      process.stdout.write(result === "already" ? "Already logged out.\n" :
        result === "removed" ? "Session was already expired or revoked; local credentials removed.\n" : "Logged out.\n");
    });
}

function registerOrganization(program: Command, runtime: Runtime): void {
  const group = program.command("organization").description("Read organizations available to the authenticated Hub User");
  withPage(group.command("list").description("List organizations where the Hub User has an active membership"))
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${PREFIX}/organizations`, query: pageQuery(options),
    })));
  group.command("get").description("Get one organization")
    .option("--organization-id <uuid>", "Organization UUID (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${PREFIX}/organizations/${segment(requiredUUID("organization-id", options.organizationId))}`,
    })));
}

function registerTaskGroup(program: Command, runtime: Runtime): void {
  const group = program.command("task-group").description("Manage task groups inside an organization");
  requestOrganization(group.command("list").description("List task groups"))
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: taskGroupPath(options),
    })));
  requestOrganization(group.command("create").description("Create a task group"))
    .option("--name <text>", "Task group name (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "POST", path: taskGroupPath(options), body: { name: required("name", options.name).trim() },
    })));
  requestOrganization(group.command("rename").description("Rename a task group"))
    .option("--task-group-id <uuid>", "Task group UUID (required)")
    .option("--name <text>", "New task group name (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "PATCH",
      path: `${PREFIX}/task-groups/${segment(requiredUUID("task-group-id", options.taskGroupId))}`,
      query: organizationQuery(options),
      body: { name: required("name", options.name).trim() },
    })));
  requestOrganization(group.command("delete").description("Delete a task group"))
    .option("--task-group-id <uuid>", "Task group UUID (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "DELETE",
      path: `${PREFIX}/task-groups/${segment(requiredUUID("task-group-id", options.taskGroupId))}`,
      query: organizationQuery(options),
    })));
}

function registerDeliveryRequest(program: Command, runtime: Runtime): void {
  const group = program.command("delivery-request").description("Manage delivery requests in an explicitly selected organization");
  withPage(requestOrganization(group.command("list").description("List delivery requests in an organization")))
    .option("--task-group-id <uuid>", "Filter by task group UUID")
    .option("--status <status>", "Filter: planning / developing / completed")
    .action(toolAction(runtime, async (options, invocation) => {
      const query = pageQuery(options);
      const groupID = optionalUUID("task-group-id", options.taskGroupId);
      if (groupID) query.set("task_group_id", groupID);
      if (options.status != null) query.set("status", enumValue("status", options.status, deliveryRequestStatuses));
      await invocation.call({ method: "GET", path: requestCollectionPath(options), query });
    }));
  requestScope(group.command("get").description("Get one delivery request"))
    .action(toolAction(runtime, callRequest("")));
  requestScope(group.command("context").description("Get the consistent Agent analysis context for one delivery request"))
    .action(toolAction(runtime, callRequest("/context")));
  requestOrganization(group.command("create").description("Create a delivery request"))
    .option("--title <text>", "Delivery request title (required)")
    .option("--description <text>", "Delivery request description (default: empty)")
    .option("--task-group-id <uuid>", "Target task group UUID")
    .action(toolAction(runtime, async (options, invocation) => {
      const body: Record<string, unknown> = {
        title: required("title", options.title).trim(),
        description: typeof options.description === "string" ? options.description : "",
      };
      const groupID = optionalUUID("task-group-id", options.taskGroupId);
      if (groupID) body.task_group_id = groupID;
      await invocation.call({ method: "POST", path: requestCollectionPath(options), body });
    }));
  requestScope(group.command("update-content").description("Update a delivery request title or description with optimistic concurrency"))
    .option("--expected-lock-version <n>", "Expected delivery request lock version (required)")
    .option("--title <text>", "New title")
    .option("--description <text>", "New description")
    .action(toolAction(runtime, async (options, invocation) => {
      if (options.title == null && options.description == null) throw new Error("--title or --description is required");
      const body: Record<string, unknown> = {
        expected_lock_version: nonNegativeInteger("expected-lock-version", options.expectedLockVersion),
      };
      if (options.title != null) body.title = required("title", options.title).trim();
      if (options.description != null) body.description = options.description;
      await invocation.call({ method: "PATCH", path: `${requestPath(options)}/content`, query: organizationQuery(options), body });
    }));
  requestScope(group.command("move").description("Move a delivery request to another task group"))
    .option("--task-group-id <uuid>", "Target task group UUID (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "PUT",
      path: `${requestPath(options)}/task-group`,
      query: organizationQuery(options),
      body: { task_group_id: requiredUUID("task-group-id", options.taskGroupId) },
    })));
}

function registerVersion(program: Command, runtime: Runtime): void {
  const group = program.command("version").description("Read, compare, and submit immutable task graph versions")
    .action(() => { process.stdout.write(`wayline-cli ${buildInfo.version}\n`); });
  withPage(requestScope(group.command("list").description("List versions")))
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${requestPath(options)}/versions`, query: organizationQuery(options, pageQuery(options)),
    })));
  requestScope(group.command("get").description("Get one version"))
    .option("--version-id <uuid>", "Version UUID (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${requestPath(options)}/versions/${segment(requiredUUID("version-id", options.versionId))}`,
      query: organizationQuery(options),
    })));
  requestScope(group.command("diff").description("Compare two versions"))
    .option("--before-version-id <uuid>", "Baseline version UUID (required)")
    .option("--after-version-id <uuid>", "Target version UUID (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET",
      path: `${requestPath(options)}/version-diff`,
      query: organizationQuery(options, new URLSearchParams({
        before: requiredUUID("before-version-id", options.beforeVersionId),
        after: requiredUUID("after-version-id", options.afterVersionId),
      })),
    })));
  requestScope(group.command("submit").description("Submit a complete task-graph-version/v1 snapshot without an edit lease"))
    .option("--expected-current-version-id <uuid>", "Current version UUID observed before offline work (required)")
    .option("--input <file|->", "task-graph-version/v1 JSON file, or - for stdin (max 16 MiB) (required)")
    .option("--name <text>", "Optional version name")
    .option("--description <text>", "Optional version description")
    .action(toolAction(runtime, async (options, invocation) => {
      const body: Record<string, unknown> = {
        expected_current_version_id: requiredUUID("expected-current-version-id", options.expectedCurrentVersionId),
        source: { type: "payload", payload: await readTaskGraphVersion(options.input) },
      };
      if (options.name != null) body.name = options.name;
      if (options.description != null) body.description = options.description;
      await invocation.call({
        method: "POST", path: `${requestPath(options)}/version-submissions`,
        query: organizationQuery(options), body,
      });
    }));
}

function registerChange(program: Command, runtime: Runtime): void {
  const group = program.command("change").description("Submit and operate the two-party approval workflow");
  withPage(requestScope(group.command("list").description("List approval changes")))
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${requestPath(options)}/changes`, query: organizationQuery(options, pageQuery(options)),
    })));
  requestScope(group.command("get").description("Get one approval change"))
    .option("--change-id <uuid>", "Change UUID (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${requestPath(options)}/changes/${segment(requiredUUID("change-id", options.changeId))}`,
      query: organizationQuery(options),
    })));
  requestScope(group.command("submit").description("Submit an existing version as an approval candidate"))
    .option("--candidate-version-id <uuid>", "Candidate version UUID (required)")
    .option("--expected-published-version-id <uuid>", "Published version UUID observed before submission (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "POST", path: `${requestPath(options)}/changes`, query: organizationQuery(options), body: {
        candidate_version_id: requiredUUID("candidate-version-id", options.candidateVersionId),
        expected_published_version_id: requiredUUID("expected-published-version-id", options.expectedPublishedVersionId),
      },
    })));
  changeCommand(group, runtime, "approve", "Approve the exact current candidate", (options) => ({
    action: "confirm",
    candidate_version_id: requiredUUID("candidate-version-id", options.candidateVersionId),
  }), (command) => command.option("--candidate-version-id <uuid>", "Exact candidate version UUID (required)"));
  changeCommand(group, runtime, "request-changes", "Reject the candidate and request changes", (options) => ({
    action: "request_changes", feedback: required("feedback", options.feedback).trim(),
  }), (command) => command.option("--feedback <text>", "Required feedback (required)"));
  changeCommand(group, runtime, "replace-candidate", "Replace the candidate and clear previous approvals", (options) => ({
    action: "replace_candidate",
    candidate_version_id: requiredUUID("candidate-version-id", options.candidateVersionId),
  }), (command) => command.option("--candidate-version-id <uuid>", "New candidate version UUID (required)"));
  changeCommand(group, runtime, "withdraw", "Withdraw an open approval change", () => ({ action: "withdraw" }));
}

function changeCommand(
  group: Command,
  runtime: Runtime,
  name: string,
  description: string,
  body: (options: Options) => Record<string, unknown>,
  configure: (command: Command) => Command = (command) => command,
): void {
  let command = requestScope(group.command(name).description(description))
    .option("--change-id <uuid>", "Change UUID (required)")
    .option("--expected-lock-version <n>", "Expected change lock version (required)");
  command = configure(command);
  command.action(toolAction(runtime, async (options, invocation) => invocation.call({
    method: "POST",
    path: `${requestPath(options)}/changes/${segment(requiredUUID("change-id", options.changeId))}/commands`,
    query: organizationQuery(options),
    body: { expected_lock_version: nonNegativeInteger("expected-lock-version", options.expectedLockVersion), ...body(options) },
  })));
}

function registerRequestRead(program: Command, runtime: Runtime, resource: string, description: string): void {
  const group = program.command(resource).description(description);
  requestScope(group.command("get").description(description))
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${requestPath(options)}/${resource}`, query: organizationQuery(options),
    })));
}

function registerTaskExecution(program: Command, runtime: Runtime): void {
  const group = program.command("task-execution").description("Read task execution state");
  requestScope(group.command("get").description("Read task execution state"))
    .option("--version-id <uuid>", "Project only the nodes of this graph version (default: current version)")
    .action(toolAction(runtime, async (options, invocation) => {
      const query = new URLSearchParams();
      const versionID = optionalUUID("version-id", options.versionId);
      if (versionID) query.set("version_id", versionID);
      await invocation.call({
        method: "GET", path: `${requestPath(options)}/task-execution`, query: organizationQuery(options, query),
      });
    }));
}

function registerDeveloperProfile(program: Command, runtime: Runtime): void {
  const group = program.command("developer-profile").description("Read developer profiles");
  withPage(group.command("list").description("List developer profiles"))
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${PREFIX}/developer-profiles`, query: pageQuery(options),
    })));
  group.command("get").description("Get one developer profile")
    .option("--developer-profile-id <uuid>", "Developer profile UUID (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET", path: `${PREFIX}/developer-profiles/${segment(requiredUUID("developer-profile-id", options.developerProfileId))}`,
    })));
}

function registerNodeComment(program: Command, runtime: Runtime): void {
  const group = program.command("node-comment").description("Read task node execution comments");
  withPage(requestScope(group.command("list").description("List comments for a published task node")))
    .option("--node-ref <ref>", "Task node ref matching n_[A-Z0-9]{6,61} (required)")
    .action(toolAction(runtime, async (options, invocation) => invocation.call({
      method: "GET",
      path: `${requestPath(options)}/task-graph/nodes/${segment(requiredNodeRef(options.nodeRef))}/comments`,
      query: organizationQuery(options, pageQuery(options)),
    })));
}

function toolAction(
  runtime: Runtime,
  action: (options: Options, invocation: ToolInvocation) => Promise<void>,
): (options: Options) => Promise<void> {
  return async (options) => {
    const invocation = new ToolInvocation(runtime.client, runtime.auth);
    await action(options, invocation);
  };
}

function callRequest(suffix: string): (options: Options, invocation: ToolInvocation) => Promise<void> {
  return async (options, invocation) => invocation.call({ method: "GET", path: requestPath(options) + suffix, query: organizationQuery(options) });
}

function withPage(command: Command): Command {
  return command.option("--limit <n>", "Page size: 1-100 (default: 20)", "20")
    .option("--cursor <cursor>", "Opaque cursor returned by the previous page");
}

function requestOrganization(command: Command): Command {
  return command.option("--organization-id <uuid>", "Organization UUID (required)");
}

function requestScope(command: Command): Command {
  return requestOrganization(command).option("--delivery-request-id <uuid>", "Delivery request UUID (required)");
}

function requestCollectionPath(options: Options): string {
  return `${PREFIX}/organizations/${segment(requiredUUID("organization-id", options.organizationId))}/delivery-requests`;
}

function requestPath(options: Options): string {
  return `${PREFIX}/delivery-requests/${segment(requiredUUID("delivery-request-id", options.deliveryRequestId))}`;
}

function taskGroupPath(options: Options): string {
  return `${PREFIX}/organizations/${segment(requiredUUID("organization-id", options.organizationId))}/task-groups`;
}

function organizationQuery(options: Options, query = new URLSearchParams()): URLSearchParams {
  query.set("organization_id", requiredUUID("organization-id", options.organizationId));
  return query;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}
