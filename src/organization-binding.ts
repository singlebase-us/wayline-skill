import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface OrganizationBinding {
  organization_id: string;
  name: string;
  bound_at: string;
}

export class OrganizationBindingStore {
  constructor(readonly root = join(homedir(), ".wayline")) {}

  private path(apiURL: string, scope: string): string {
    const key = createHash("sha256").update(`${apiURL}\n${scope}`).digest("hex").slice(0, 16);
    return join(this.root, "organizations", `${key}.json`);
  }

  async get(apiURL: string, scope: string): Promise<OrganizationBinding> {
    const path = this.path(apiURL, scope);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) throw new OrganizationBindingNotFoundError();
      throw error;
    }
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error("organization binding must be a private regular file with mode 0600; run organization use again");
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error("stored organization binding is invalid; run organization use again");
    }
    const binding = value as Partial<OrganizationBinding>;
    if (typeof binding.organization_id !== "string" || !binding.organization_id) {
      throw new Error("stored organization binding is invalid; run organization use again");
    }
    return {
      organization_id: binding.organization_id,
      name: typeof binding.name === "string" ? binding.name : "",
      bound_at: typeof binding.bound_at === "string" ? binding.bound_at : "",
    };
  }

  async set(apiURL: string, scope: string, organizationID: string, name: string): Promise<void> {
    const path = this.path(apiURL, scope);
    await privateDirectory(dirname(path));
    const temporary = join(dirname(path), `.binding-${process.pid}-${Date.now()}`);
    const binding: OrganizationBinding = { organization_id: organizationID, name, bound_at: new Date().toISOString() };
    try {
      await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async delete(apiURL: string, scope: string): Promise<boolean> {
    try {
      await rm(this.path(apiURL, scope));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

export class OrganizationBindingNotFoundError extends Error {
  constructor() {
    super("no organization binding for this directory");
    this.name = "OrganizationBindingNotFoundError";
  }
}

export function projectScope(directory = process.cwd()): string {
  const start = resolve(directory);
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}
