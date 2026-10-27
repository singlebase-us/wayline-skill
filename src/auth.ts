import { hostname, platform, arch } from "node:os";
import { spawn } from "node:child_process";
import { Credential, CredentialStore, PendingLogin } from "./credentials.js";
import { CredentialsNotFoundError, isInvalidCredential, OAuthError } from "./errors.js";
import { HttpClient } from "./http.js";

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface UserToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
}

export interface UserSession {
  id: string;
  client_id: string;
  display_name: string;
  status: string;
  absolute_expires_at: string;
  idle_expires_at: string;
  last_used_at: string;
  created_at: string;
}

export interface AccessContext {
  credential: Credential;
  refresh: Promise<void>;
}

export class UserAuth {
  constructor(
    readonly client: HttpClient,
    readonly apiURL: string,
    readonly store = new CredentialStore(),
    private readonly now: () => Date = () => new Date(),
    private readonly browserOpener: (url: string) => Promise<void> = openBrowser,
    private readonly wait: (milliseconds: number) => Promise<void> = delay,
  ) {}

  async createDeviceAuthorization(deviceName: string): Promise<DeviceAuthorization> {
    const value = await this.client.request<DeviceAuthorization>(
      "POST",
      "/user/api/v1/user/cli/device-authorizations",
      "",
      { client_id: "wayline-cli", device_name: deviceName },
    );
    if (!value.device_code || !value.user_code || !value.verification_uri ||
      !value.verification_uri_complete || value.expires_in <= 0 || value.interval <= 0) {
      throw new Error("Wayline API returned an invalid device authorization");
    }
    return value;
  }

  async exchangeDeviceCode(deviceCode: string): Promise<UserToken> {
    return this.validToken(await this.client.request<UserToken>("POST", "/user/api/v1/user/cli/token", "", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "wayline-cli",
      device_code: deviceCode,
    }));
  }

  async startLogin(deviceName: string, noBrowser: boolean, write: (value: string) => void): Promise<void> {
    await this.assertNotAuthenticated();
    let pending = await this.store.getPending(this.apiURL, this.now());
    if (!pending) {
      const authorization = await this.createDeviceAuthorization(deviceName);
      pending = {
        device_code: authorization.device_code,
        user_code: authorization.user_code,
        verification_uri: authorization.verification_uri,
        verification_uri_complete: authorization.verification_uri_complete,
        expires_at: new Date(this.now().getTime() + authorization.expires_in * 1_000).toISOString(),
        interval: authorization.interval,
      };
      await this.store.setPending(this.apiURL, pending);
    }
    if (noBrowser) {
      writeBrowserFallback(pending, write);
    } else {
      write("Opening your browser to confirm this Wayline CLI login...");
      try {
        await this.browserOpener(pending.verification_uri_complete);
      } catch {
        write("Could not open your browser automatically; use the link below instead.");
        writeBrowserFallback(pending, write);
      }
    }
  }

  async login(deviceName: string, noBrowser: boolean, write: (value: string) => void): Promise<void> {
    await this.startLogin(deviceName, noBrowser, write);
    const pending = await this.pendingOrExpired();
    let interval = pending.interval * 1_000;
    const deadline = Date.parse(pending.expires_at);
    while (Number.isFinite(deadline) && this.now().getTime() < deadline) {
      await this.wait(interval);
      try {
        await this.storeCredentials(await this.exchangeDeviceCode(pending.device_code));
        return;
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        if (error.code === "authorization_pending") continue;
        if (error.code === "slow_down") {
          interval += 5_000;
          continue;
        }
        await this.store.deletePending(this.apiURL);
        if (error.code === "access_denied") throw new Error("device authorization was denied");
        if (["expired_token", "invalid_grant"].includes(error.code)) {
          throw new Error("device authorization expired; run auth login again");
        }
        throw error;
      }
    }
    await this.store.deletePending(this.apiURL);
    throw new Error("device authorization expired; run auth login again");
  }

  async pendingLogin(): Promise<PendingLogin | null> {
    try {
      await this.store.get(this.apiURL);
      return null;
    } catch (error) {
      if (!(error instanceof CredentialsNotFoundError)) throw error;
    }
    return this.store.getPending(this.apiURL, this.now());
  }

  /** Finishes a login that was started without waiting. Returns false while the browser approval is still pending. */
  async finishPendingLogin(): Promise<boolean> {
    const pending = await this.pendingLogin();
    if (!pending) return false;
    try {
      await this.storeCredentials(await this.exchangeDeviceCode(pending.device_code));
      return true;
    } catch (error) {
      if (error instanceof OAuthError && error.code === "authorization_pending") return false;
      if (error instanceof OAuthError && ["access_denied", "expired_token", "invalid_grant"].includes(error.code)) {
        await this.store.deletePending(this.apiURL);
        return false;
      }
      throw error;
    }
  }

  private async pendingOrExpired(): Promise<PendingLogin> {
    const pending = await this.store.getPending(this.apiURL, this.now());
    if (!pending) throw new Error("device authorization expired; run auth login again");
    return pending;
  }

  private async assertNotAuthenticated(): Promise<void> {
    try {
      await this.store.get(this.apiURL);
    } catch (error) {
      if (error instanceof CredentialsNotFoundError) return;
      throw error;
    }
    throw new Error("already authenticated; run wayline-cli auth logout before logging in again");
  }

  private async storeCredentials(token: UserToken): Promise<void> {
    const now = this.now();
    const credential: Credential = {
      refresh_token: token.refresh_token,
      access_token: token.access_token,
      access_obtained_at: now.toISOString(),
      access_expires_at: new Date(now.getTime() + token.expires_in * 1_000).toISOString(),
      refresh_expires_at: new Date(now.getTime() + token.refresh_expires_in * 1_000).toISOString(),
    };
    try {
      await this.store.set(this.apiURL, credential);
    } catch (error) {
      await this.revoke(token.access_token).catch(() => undefined);
      throw new Error(`store login credentials (remote session was revoked): ${message(error)}`);
    }
    await this.store.deletePending(this.apiURL);
  }

  async status(): Promise<UserSession> {
    let access: AccessContext;
    try {
      access = await this.accessForOperation(true);
    } catch (error) {
      if (error instanceof CredentialsNotFoundError) throw new Error("not authenticated; run wayline-cli auth login");
      throw error;
    }
    const sessionPromise = this.client.request<UserSession>("GET", "/user/api/v1/user/cli/session", access.credential.access_token);
    const [sessionResult, refreshResult] = await Promise.allSettled([sessionPromise, access.refresh]);
    if (sessionResult.status === "rejected") throw sessionResult.reason;
    if (refreshResult.status === "rejected") {
      process.stderr.write(`warning: could not refresh Hub User Access Token: ${message(refreshResult.reason)}\n`);
    }
    const session = sessionResult.value;
    if (!session.id || !session.client_id || !session.status) throw new Error("Wayline API returned an invalid CLI session");
    return session;
  }

  async logout(): Promise<"already" | "removed" | "revoked"> {
    // An abandoned sign-in must not be resumable after the user asked to be signed out.
    await this.store.deletePending(this.apiURL);
    let access: AccessContext;
    try {
      access = await this.accessForOperation(false);
    } catch (error) {
      if (error instanceof CredentialsNotFoundError) return "already";
      throw error;
    }
    await access.refresh;
    try {
      await this.revoke(access.credential.access_token ?? "");
    } catch (error) {
      if (!isInvalidCredential(error)) throw error;
      await this.store.delete(this.apiURL);
      return "removed";
    }
    await this.store.delete(this.apiURL);
    return "revoked";
  }

  async accessForOperation(allowBackgroundRefresh: boolean): Promise<AccessContext> {
    let credential = await this.store.get(this.apiURL);
    const now = this.now();
    if (!accessUsable(credential, now)) {
      credential = await this.refreshAccess(credential);
      return { credential, refresh: Promise.resolve() };
    }
    const obtained = Date.parse(credential.access_obtained_at ?? "");
    const expires = Date.parse(credential.access_expires_at ?? "");
    const shouldRefresh = Number.isFinite(obtained) && Number.isFinite(expires) && expires > obtained &&
      now.getTime() - obtained >= (expires - obtained) / 3;
    if (!allowBackgroundRefresh || !shouldRefresh || !refreshMayBeValid(credential, now)) {
      return { credential, refresh: Promise.resolve() };
    }
    const refresh = this.refreshAccess(credential).then(() => undefined);
    return { credential, refresh };
  }

  private async refreshAccess(previous: Credential): Promise<Credential> {
    return this.store.withLock(this.apiURL, async () => {
      let credential = await this.store.get(this.apiURL);
      const now = this.now();
      if (credential.refresh_token !== previous.refresh_token && accessUsable(credential, now)) return credential;
      if (!refreshMayBeValid(credential, now)) {
        await this.store.delete(this.apiURL);
        throw new Error("CLI session expired; run wayline-cli auth login");
      }
      let token: UserToken;
      try {
        token = this.validToken(await this.client.request<UserToken>("POST", "/user/api/v1/user/cli/token", "", {
          grant_type: "refresh_token",
          client_id: "wayline-cli",
          refresh_token: credential.refresh_token,
        }));
      } catch (error) {
        if (isInvalidCredential(error)) {
          await this.store.delete(this.apiURL);
          throw new Error("CLI session expired or revoked; run wayline-cli auth login");
        }
        throw error;
      }
      const refreshedAt = this.now();
      credential = {
        ...credential,
        refresh_token: token.refresh_token,
        access_token: token.access_token,
        access_obtained_at: refreshedAt.toISOString(),
        access_expires_at: new Date(refreshedAt.getTime() + token.expires_in * 1_000).toISOString(),
        refresh_expires_at: new Date(refreshedAt.getTime() + token.refresh_expires_in * 1_000).toISOString(),
      };
      try {
        await this.store.set(this.apiURL, credential);
      } catch (error) {
        await this.revoke(token.access_token).catch(() => undefined);
        await this.store.delete(this.apiURL);
        throw new Error(`persist rotated credentials (remote session was revoked): ${message(error)}`);
      }
      return credential;
    });
  }

  private async revoke(accessToken: string): Promise<void> {
    await this.client.request("DELETE", "/user/api/v1/user/cli/session", accessToken);
  }

  private validToken(token: UserToken): UserToken {
    if (!token.access_token || !token.refresh_token || token.token_type !== "Bearer" ||
      token.expires_in <= 0 || token.refresh_expires_in <= 0) {
      throw new Error("Wayline API returned an invalid CLI Token");
    }
    return token;
  }
}

function writeBrowserFallback(
  authorization: { user_code: string; verification_uri: string; verification_uri_complete: string },
  write: (value: string) => void,
): void {
  write("Open this URL in a browser to confirm the Wayline CLI login:");
  write(authorization.verification_uri_complete);
  write(
    `If the complete link cannot be used, open ${authorization.verification_uri} and enter code: ${authorization.user_code}`,
  );
}

export function defaultDeviceName(): string {
  const name = hostname().trim();
  return name ? `${name} (Wayline CLI)` : "Wayline CLI";
}

export function userAgent(version: string): string {
  return `wayline-cli/${version} (${platform()}/${arch()})`;
}

function accessUsable(credential: Credential, now: Date): boolean {
  const obtained = Date.parse(credential.access_obtained_at ?? "");
  const expires = Date.parse(credential.access_expires_at ?? "");
  return !!credential.access_token && Number.isFinite(obtained) && Number.isFinite(expires) &&
    expires > obtained && now.getTime() < expires;
}

function refreshMayBeValid(credential: Credential, now: Date): boolean {
  if (!credential.refresh_expires_at) return true;
  const expires = Date.parse(credential.refresh_expires_at);
  return !Number.isFinite(expires) || now.getTime() < expires;
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
