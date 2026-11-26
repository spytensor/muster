import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { builtInServer, cleanServer } from "./server.js";
import type { Task, TaskStore } from "./task.js";

export { cleanServer };

const dir = () => {
  const path = app.getPath("userData");
  mkdirSync(path, { recursive: true });
  return path;
};
const configFile = () => join(dir(), "config.json");
const tokenFile = () => join(dir(), "session.bin");

/** The server to open: the one asked for at launch, else the one the person chose, else the build's own. */
export function readServer(): string | null {
  const fromEnv = process.env.MUSTER_SERVER ? cleanServer(process.env.MUSTER_SERVER) : null;
  if (fromEnv) return fromEnv;
  const { server } = config();
  return (typeof server === "string" ? cleanServer(server) : null) ?? builtInServer();
}
const config = (): { server?: unknown; theme?: unknown } => {
  try {
    const saved = JSON.parse(readFileSync(configFile(), "utf8"));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
};
export function saveServer(server: string | null): void {
  const { server: _old, ...rest } = config();
  writeFileSync(configFile(), JSON.stringify(server ? { ...rest, server } : rest));
}

export type Theme = "system" | "light" | "dark";
/** The appearance the person chose in the page; the device's own until they choose. */
export function readTheme(): Theme {
  const { theme } = config();
  return theme === "light" || theme === "dark" ? theme : "system";
}
export function saveTheme(theme: Theme): void {
  try {
    writeFileSync(configFile(), JSON.stringify({ ...config(), theme }));
  } catch {
    // Not kept this time: the window opens in the device's appearance and is told again.
  }
}

/**
 * The session token, kept encrypted with the operating system's keychain.
 * When the keychain is not available the token is not kept at all, and the
 * person signs in again next time.
 */
export function readToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(tokenFile())) return null;
    return safeStorage.decryptString(readFileSync(tokenFile()));
  } catch {
    return null;
  }
}
export function saveToken(token: string | null): void {
  if (!token || !safeStorage.isEncryptionAvailable()) {
    rmSync(tokenFile(), { force: true });
    return;
  }
  writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 });
}

const foldersFile = () => join(dir(), "folders.json");
type Folders = Record<string, Record<string, string[]>>;
const allFolders = (): Folders => {
  try {
    const saved = JSON.parse(readFileSync(foldersFile(), "utf8"));
    return saved && typeof saved === "object" ? (saved as Folders) : {};
  } catch {
    return {};
  }
};
/**
 * The folders on this computer a person attached to a project, kept on this computer
 * only: the server is never told where they are. Kept apart for each server, so a
 * project of one never opens the folders of another.
 */
export function readFolders(server: string, projectId: string): string[] {
  const list = allFolders()[server]?.[projectId];
  return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
}
export function saveFolders(server: string, projectId: string, folders: string[]): void {
  const all = allFolders();
  const mine = { ...(all[server] ?? {}) };
  if (folders.length) mine[projectId] = folders;
  else delete mine[projectId];
  writeFileSync(foldersFile(), JSON.stringify({ ...all, [server]: mine }));
}

const tasksFile = () => join(dir(), "tasks.json");
/**
 * The work conversations have under way in the attached repositories (task.ts): which
 * branch, cut from where, and the copy of the repository it is in when it is not the
 * folder itself. Kept on this computer only, like the folders.
 */
export const taskStore = (): TaskStore => ({
  all: () => {
    try {
      const saved = JSON.parse(readFileSync(tasksFile(), "utf8"));
      return Array.isArray(saved) ? (saved as Task[]) : [];
    } catch {
      return [];
    }
  },
  save: (tasks) => {
    try {
      writeFileSync(tasksFile(), JSON.stringify(tasks));
    } catch {
      // Not kept this time: the next change finds the branch again by its name.
    }
  },
});
/** Where the copies of repositories that work is done in are kept. */
export const copiesDir = () => join(dir(), "worktrees");
