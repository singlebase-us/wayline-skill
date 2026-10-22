export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly apiMessage: string,
    readonly path = "",
    readonly details?: Record<string, unknown>,
    readonly requestId = "",
  ) {
    super(code
      ? `Wayline API returned HTTP ${status} (${code}): ${apiMessage}`
      : `Wayline API returned HTTP ${status}: ${apiMessage}`);
    this.name = "ApiError";
  }
}

export class OAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OAuthError";
  }
}

export class CredentialsNotFoundError extends Error {
  constructor() {
    super("credentials not found");
    this.name = "CredentialsNotFoundError";
  }
}

export class ToolError extends Error {
  constructor(
    readonly body: {
      code: string;
      message: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    },
    readonly requestId: string,
  ) {
    super(body.message);
    this.name = "ToolError";
  }
}

export function isInvalidCredential(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403) ||
    error instanceof OAuthError && ["invalid_grant", "expired_token", "access_denied"].includes(error.code);
}
