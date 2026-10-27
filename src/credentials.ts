import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CredentialsNotFoundError } from "./errors.js";

export interface Credential {
  refresh_token: string;
  access_token?: string;
  access_obtained_at?: string;
  access_expires_at?: string;
  subject_id?: string;
  username?: string;
  email?: string;
  refresh_expires_at?: string;
}

export interface PendingLogin {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_at: string;
  interval: number;
}

const ACTOR = "user";

export class CredentialStore {
  constructor(readonly root = join(homedir(), ".wayline")) {}

  private key(apiURL: string): string {
    return createHash("sha256").update(apiURL).digest("hex").slice(0, 16);
  }

  private path(apiURL: string): string {
    return join(this.root, "credentials", `${ACTOR}-${this.key(apiURL)}.json`);
  }

  private pendingPath(apiURL: string): string {
    return join(this.root, "credentials", `${ACTOR}-pending-${this.key(apiURL)}.json`);
  }

  private lockPath(apiURL: string): string {
    return join(this.root, "locks", `${ACTOR}-${this.key(apiURL)}.v2.lock`);
  }

  async get(apiURL: string): Promise<Credential> {
    const value = await this.readJSON(this.path(apiURL), "stored credentials are invalid; run auth login again");
    if (value === null) throw new CredentialsNotFoundError();
    if (typeof (value as Credential).refresh_token !== "string" || !(value as Credential).refresh_token) {
      throw new Error("stored credentials are invalid; run auth login again");
    }
    return value as Credential;
  }

  async getPending(apiURL: string, now = new Date()): Promise<PendingLogin | null> {
    const value = await this.readJSON(this.pendingPath(apiURL), "stored device authorization is invalid; run auth login again");
    if (value === null) return null;
    const pending = value as Partial<PendingLogin>;
    if (typeof pending.device_code !== "string" || !pending.device_code ||
      typeof pending.verification_uri_complete !== "string" || !pending.verification_uri_complete) {
      throw new Error("stored device authorization is invalid; run auth login again");
    }
    const expires = Date.parse(pending.expires_at ?? "");
    if (Number.isFinite(expires) && now.getTime() >= expires) {
      await this.deletePending(apiURL);
      return null;
    }
    return {
      device_code: pending.device_code,
      user_code: typeof pending.user_code === "string" ? pending.user_code : "",
      verification_uri: typeof pending.verification_uri === "string" ? pending.verification_uri : "",
      verification_uri_complete: pending.verification_uri_complete,
      expires_at: typeof pending.expires_at === "string" ? pending.expires_at : "",
      interval: typeof pending.interval === "number" && pending.interval > 0 ? pending.interval : 5,
    };
  }

  async setPending(apiURL: string, pending: PendingLogin): Promise<void> {
    if (!pending.device_code) throw new Error("refusing to store an empty device code");
    await writePrivate(this.pendingPath(apiURL), pending);
  }

  async deletePending(apiURL: string): Promise<void> {
    await rm(this.pendingPath(apiURL), { force: true });
  }

  private async readJSON(path: string, invalid: string): Promise<unknown | null> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("credential path must be a regular file");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`credential file permissions must be 0600, got 0${(info.mode & 0o777).toString(8)}`);
    }
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error(invalid);
    }
  }

  async set(apiURL: string, credential: Credential): Promise<void> {
    if (!credential.refresh_token) throw new Error("refusing to store an empty refresh token");
    await writePrivate(this.path(apiURL), credential);
  }

  async delete(apiURL: string): Promise<void> {
    await rm(this.path(apiURL), { force: true });
  }

  async withLock<T>(apiURL: string, operation: () => Promise<T>): Promise<T> {
    const path = this.lockPath(apiURL);
    await privateDirectory(dirname(path));
    const started = Date.now();
    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
          return await operation();
        } finally {
          await handle.close();
          await unlink(path).catch(() => undefined);
        }
      } catch (error) {
        if (!isExists(error)) throw error;
        try {
          const info = await stat(path);
          if (Date.now() - info.mtimeMs > 120_000) {
            await unlink(path);
            continue;
          }
        } catch (inspectError) {
          if (isNotFound(inspectError)) continue;
        }
        if (Date.now() - started > 30_000) throw new Error("timed out waiting for credential refresh lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.credential-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    if (process.platform === "win32") await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST";
}
