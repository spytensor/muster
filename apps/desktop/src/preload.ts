import { contextBridge, ipcRenderer } from "electron";

/** What the page may ask the desktop app to do. Each request is checked again in the main process. */
const desktop = {
  platform: process.platform,
  /** Opens the system browser to sign in. Resolves to true once this app holds a session. */
  signIn: (provider?: string): Promise<boolean> => ipcRenderer.invoke("muster:sign-in", provider),
  signOut: (): Promise<void> => ipcRenderer.invoke("muster:sign-out"),
  /** The server this app talks to, or null before one is chosen. */
  server: (): Promise<string | null> => ipcRenderer.invoke("muster:server"),
  /** Points the app at a server. Resolves to an error code, or null when it worked. */
  setServer: (address: string): Promise<string | null> =>
    ipcRenderer.invoke("muster:set-server", address),
  /** Forgets the server and the session, and shows the first-run page. */
  changeServer: (): Promise<void> => ipcRenderer.invoke("muster:change-server"),
  /** The folders on this computer attached to a project: the name agents use, and where each is. */
  folders: (projectId: string): Promise<{ name: string; path: string }[]> =>
    ipcRenderer.invoke("muster:folders", projectId),
  /** Lets the person pick a folder in the system's dialog and attaches it. Resolves to the new list. */
  addFolder: (projectId: string): Promise<{ name: string; path: string }[]> =>
    ipcRenderer.invoke("muster:add-folder", projectId),
  removeFolder: (projectId: string, path: string): Promise<{ name: string; path: string }[]> =>
    ipcRenderer.invoke("muster:remove-folder", projectId, path),
  /** Lets the person pick a folder for a project that is not made yet. Null when they picked none. */
  pickFolder: (): Promise<{ name: string; path: string } | null> =>
    ipcRenderer.invoke("muster:pick-folder"),
  /** Attaches a folder picked with `pickFolder` to the project made since. */
  attachPicked: (projectId: string, path: string): Promise<{ name: string; path: string }[]> =>
    ipcRenderer.invoke("muster:attach-picked", projectId, path),
  /** Says that folders picked with `pickFolder` are not wanted after all. */
  forgetPicked: (paths: string[]): Promise<void> =>
    ipcRenderer.invoke("muster:forget-picked", paths),
  /** Does what an agent asked in the project's folders: list, read, search or write. */
  local: (
    projectId: string,
    tool: string,
    args: Record<string, unknown>,
    /** Which call of which conversation this is: the app asks the server what it holds for it, and does that. */
    call?: { conversation: string; id: string },
  ): Promise<{ ok: boolean; text: string; skip?: boolean }> =>
    ipcRenderer.invoke("muster:local", projectId, tool, args, call),
  /** What the attached folders are: which are repositories, their branch and state, their own instructions. */
  describe: (
    projectId: string,
    /** The conversation whose work it is: its folders may be its own copies of the repositories. */
    conversationId?: string,
  ): Promise<
    {
      name: string;
      repository: boolean;
      branch: string | null;
      changed: number | null;
      instructions: { file: string; text: string }[];
      checks: string[];
    }[]
  > => ipcRenderer.invoke("muster:describe", projectId, conversationId),
  /** What changed in the project's repositories and is not committed, with the difference for each file. */
  changes: (
    projectId: string,
    conversationId?: string,
  ): Promise<
    {
      name: string;
      branch: string | null;
      files: { path: string; state: string; diff: string; agent: boolean }[];
      more: number;
    }[]
  > => ipcRenderer.invoke("muster:changes", projectId, conversationId),
  /**
   * How a conversation's work stands in each repository: the branch it is on, whether it
   * is in a copy of the repository, how far ahead it is, and its pull request.
   */
  task: (
    projectId: string,
    conversationId: string,
  ): Promise<
    {
      name: string;
      branch: string;
      base: string;
      copy: boolean;
      ahead: number | null;
      remote: boolean;
      pr: {
        url: string;
        number: number | null;
        state: "OPEN" | "MERGED" | "CLOSED";
        checks: "none" | "pending" | "failing" | "passing";
        failing: string[];
        comments: number;
        looked: number;
      } | null;
    }[]
  > => ipcRenderer.invoke("muster:task", projectId, conversationId),
  /** The commands going on in the project. */
  jobs: (
    projectId: string,
  ): Promise<
    {
      id: string;
      command: string;
      where: string;
      running: boolean;
      seconds: number;
      code: number | null;
      tail: string;
    }[]
  > => ipcRenderer.invoke("muster:jobs", projectId),
  stopJob: (projectId: string, id: string): Promise<void> =>
    ipcRenderer.invoke("muster:stop-job", projectId, id),
  /** The files of the project's folders, by folder. Names only. */
  tree: (
    projectId: string,
    conversationId?: string,
  ): Promise<{ name: string; files: string[]; more: boolean }[]> =>
    ipcRenderer.invoke("muster:tree", projectId, conversationId),
  /** One file's text, for the person to read. The path begins with the folder's name. */
  view: (
    projectId: string,
    path: string,
    conversationId?: string,
  ): Promise<{ ok: boolean; text: string }> =>
    ipcRenderer.invoke("muster:view", projectId, path, conversationId),
  /** Whether the app answers what agents ask over its own connection, so that the page need not. */
  answers: (): Promise<boolean> => ipcRenderer.invoke("muster:answers"),
  /** The replies whose file changes can be put back, and which files each changed. */
  undoable: (projectId: string): Promise<{ reply: string; files: string[] }[]> =>
    ipcRenderer.invoke("muster:undoable", projectId),
  /** Puts back what a reply changed with the file tools. Says, file by file, what became of it. */
  undo: (projectId: string, reply: string): Promise<string[]> =>
    ipcRenderer.invoke("muster:undo", projectId, reply),
  /** Ends the commands a stopped run was waiting on. */
  halt: (projectId: string): Promise<void> => ipcRenderer.invoke("muster:halt", projectId),
  /** The appearance the person chose in the page, so the window and its material match it. */
  setTheme: (mode: "system" | "light" | "dark"): void => ipcRenderer.send("muster:theme", mode),
  /** How many things wait for the person, shown on the app's icon. */
  setWaiting: (count: number): void => ipcRenderer.send("muster:waiting", count),
  /** Tells the person something happened while the window was in the background. */
  notify: (title: string, body: string): void => ipcRenderer.send("muster:notify", title, body),
};
export type MusterDesktop = typeof desktop;

contextBridge.exposeInMainWorld("musterDesktop", desktop);

// ---- the window's look ----
// On a Mac the window's buttons sit over the page, so the page is told to leave them room
// (apps/web/src/index.css), and told again when full screen takes the buttons away.
const root = () => document.documentElement;
let full = false;
const mark = () => {
  if (process.platform === "darwin") root().classList.add("desktop-mac");
  root().classList.toggle("desktop-full", full);
};
ipcRenderer.on("muster:full-screen", (_event, on: unknown) => {
  full = on === true;
  if (document.documentElement) mark();
});
window.addEventListener("DOMContentLoaded", mark);
