import { ApiError, OAuthError } from "./errors.js";

const MAX_AUTH_RESPONSE_BYTES = 1 << 20;
const MAX_TOOL_RESPONSE_BYTES = 16 << 20;

interface ErrorEnvelope {
  code?: unknown;
  message?: unknown;
  error?: unknown;
  path?: unknown;
  details?: unknown;
}

interface SuccessEnvelope<T> {
  code: number;
  data: T;
}

export interface ToolRequest {
  method: string;
  path: string;
  accessToken?: string;
  query?: URLSearchParams;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ToolResponse {
  data: unknown;
  requestId: string;
}

export class HttpClient {
  readonly baseURL: URL;

  constructor(baseURL: string, readonly userAgent: string, private readonly fetcher: typeof fetch = fetch) {
    this.baseURL = new URL(baseURL);
    if (!/^https?:$/.test(this.baseURL.protocol) || !this.baseURL.host) {
      throw new Error(`invalid API URL ${JSON.stringify(baseURL)}`);
    }
  }

  async request<T>(method: string, path: string, accessToken = "", body?: unknown): Promise<T> {
    const response = await this.send({ method, path, accessToken, body }, MAX_AUTH_RESPONSE_BYTES);
    const envelope = response.value as Partial<SuccessEnvelope<T>>;
    if (envelope.code !== 0 || !("data" in envelope)) {
      throw new Error("Wayline API returned an invalid success envelope");
    }
    return envelope.data as T;
  }

  async callTool(input: ToolRequest): Promise<ToolResponse> {
    const response = await this.send(input, MAX_TOOL_RESPONSE_BYTES);
    const envelope = response.value as Partial<SuccessEnvelope<unknown>>;
    if (envelope.code !== 0 || !("data" in envelope)) {
      throw new Error("Wayline API returned an invalid success envelope");
    }
    return { data: envelope.data, requestId: response.requestId };
  }

  private async send(input: ToolRequest, maximumBytes: number): Promise<{ value: unknown; requestId: string }> {
    const endpoint = new URL(input.path.replace(/^\/+/, ""), this.baseURL.toString().replace(/\/?$/, "/"));
    if (input.query) endpoint.search = input.query.toString();
    const headers = new Headers({ Accept: "application/json", "User-Agent": this.userAgent });
    if (input.accessToken) headers.set("Authorization", `Bearer ${input.accessToken}`);
    for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, value);
    let encodedBody: string | undefined;
    if (input.body !== undefined) {
      encodedBody = JSON.stringify(input.body);
      headers.set("Content-Type", "application/json");
    }
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: input.method,
        headers,
        body: encodedBody,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`call Wayline API: ${error instanceof Error ? error.message : String(error)}`);
    }
    const requestId = (response.headers.get("X-Request-ID") ?? "").trim();
    const bytes = await readLimitedBody(response, maximumBytes);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      if (!response.ok) throw new ApiError(response.status, "", response.statusText, "", undefined, requestId);
      throw new Error("Wayline API returned invalid JSON");
    }
    if (!response.ok) throw decodeError(response.status, value, requestId);
    return { value, requestId };
  }
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const label = maximumBytes === MAX_TOOL_RESPONSE_BYTES ? "16 MiB" : "1 MiB";
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`Wayline API response exceeded ${label}`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`Wayline API response exceeded ${label}`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeError(status: number, value: unknown, requestId: string): Error {
  const body = value && typeof value === "object" ? value as ErrorEnvelope : {};
  if (typeof body.error === "string" && body.error) return new OAuthError(body.error);
  const code = body.code == null ? "" : String(body.code);
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : `HTTP ${status}`;
  const path = typeof body.path === "string" ? body.path : "";
  const details = body.details && typeof body.details === "object" && !Array.isArray(body.details)
    ? body.details as Record<string, unknown>
    : undefined;
  return new ApiError(status, code, message, path, details, requestId);
}
