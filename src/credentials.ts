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

const ACTOR = "user";

export class CredentialStore {
  constructor(readonly root = join(homedir(), ".wayline")) {}

  private key(apiURL: string): string {
    return createHash("sha256").update(apiURL).digest("hex").slice(0, 16);
  }

  private path(apiURL: string): string {
    return join(this.root, "credentials", `${ACTOR}-${this.key(apiURL)}.json`);
  }

  private lockPath(apiURL: string): string {
    return join(this.root, "locks", `${ACTOR}-${this.key(apiURL)}.v2.lock`);
  }

  async get(apiURL: string): Promise<Credential> {
    const path = this.path(apiURL);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) throw new CredentialsNotFoundError();
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("credential path must be a regular file");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`credential file permissions must be 0600, got 0${(info.mode & 0o777).toString(8)}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error("stored credentials are invalid; run auth login again");
    }
    if (!value || typeof value !== "object" || typeof (value as Credential).refresh_token !== "string" || !(value as Credential).refresh_token) {
      throw new Error("stored credentials are invalid; run auth login again");
    }
    return value as Credential;
  }

  async set(apiURL: string, credential: Credential): Promise<void> {
    if (!credential.refresh_token) throw new Error("refusing to store an empty refresh token");
    const path = this.path(apiURL);
    await privateDirectory(dirname(path));
    const temporary = join(dirname(path), `.credential-${process.pid}-${randomUUID()}`);
    try {
      await writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      if (process.platform === "win32") await rm(path, { force: true });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
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
