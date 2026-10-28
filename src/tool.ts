import { randomUUID } from "node:crypto";
import { ApiError, CredentialsNotFoundError, ToolError } from "./errors.js";
import { HttpClient, ToolRequest } from "./http.js";
import { UserAuth } from "./auth.js";

export const RESULT_SCHEMA = "wayline-cli-result/v1";
export const TASK_GRAPH_VERSION_SCHEMA = "task-graph-version/v1";

export interface OrganizationScope {
  organization_id: string;
  organization_source: "flag" | "binding" | "single_membership";
}

interface ToolMeta {
  request_id: string;
  warnings: string[];
  organization_id?: string;
  organization_source?: OrganizationScope["organization_source"];
}

export function writeJSON(value: unknown, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export function writeToolError(error: ToolError): void {
  writeJSON({
    schema: RESULT_SCHEMA,
    ok: false,
    error: error.body,
    meta: meta(error.requestId, [], error.organization),
  }, process.stderr);
}

export class ToolInvocation {
  readonly id = randomUUID();
  readonly warnings: string[] = [];
  organization?: OrganizationScope;

  constructor(readonly client: HttpClient, readonly auth: UserAuth) {}

  localSuccess(data: unknown): void {
    this.success(data, this.id);
  }

  failure(code: string, message: string, retryable = false, details?: Record<string, unknown>): ToolError {
    return new ToolError(
      { code, message, retryable, ...(details ? { details } : {}) },
      this.id,
      this.organization,
    );
  }

  wrap(error: unknown): ToolError {
    if (error instanceof ToolError) return error;
    if (error instanceof CredentialsNotFoundError) {
      return this.failure("not_authenticated", "run auth login before using business tools");
    }
    if (error instanceof ApiError) {
      const details = { ...(error.details ?? {}), ...(error.path ? { path: error.path } : {}) };
      const code = error.code || "api_error";
      return new ToolError({
        code,
        message: error.apiMessage,
        retryable: error.status === 429 || error.status >= 500 ||
          error.status === 409 && (code.includes("conflict") || code.includes("stale")),
        ...(Object.keys(details).length ? { details } : {}),
      }, error.requestId || this.id, this.organization);
    }
    return this.failure("transport_error", message(error), true);
  }

  async call(request: ToolRequest, select: (data: unknown) => unknown | Promise<unknown> = (data) => data): Promise<void> {
    const response = await this.send(request);
    this.success(await select(response.data), response.requestId || this.id);
  }

  async fetch(request: ToolRequest): Promise<unknown> {
    return (await this.send(request)).data;
  }

  private async send(request: ToolRequest): Promise<{ data: unknown; requestId: string }> {
    let access;
    try {
      access = await this.auth.accessForOperation(true);
    } catch (error) {
      throw this.wrap(error);
    }
    request.accessToken = access.credential.access_token;
    request.headers = { ...(request.headers ?? {}), "X-Request-ID": this.id };
    const [operation, refresh] = await Promise.allSettled([this.client.callTool(request), access.refresh]);
    if (operation.status === "rejected") throw this.wrap(operation.reason);
    if (refresh.status === "rejected") {
      this.warnings.push(`could not refresh Hub User Access Token: ${message(refresh.reason)}`);
    }
    return operation.value;
  }

  private success(data: unknown, requestId: string): void {
    writeJSON({
      schema: RESULT_SCHEMA,
      ok: true,
      data,
      meta: meta(requestId, this.warnings, this.organization),
    });
  }
}

function meta(requestId: string, warnings: string[], organization?: OrganizationScope): ToolMeta {
  return { request_id: requestId, warnings, ...organization };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
