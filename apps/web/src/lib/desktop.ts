export interface LocalFolder {
  name: string;
  path: string;
}

/** What the desktop app offers the page it shows. Absent in a browser. See apps/desktop/src/preload.ts. */
export interface Desktop {
  platform: string;
  /** Opens the person's browser to sign in, at the given way of signing in when the server offers several. */
  signIn(provider?: string): Promise<boolean>;
  signOut(): Promise<void>;
  changeServer(): Promise<void>;
  /** Tells the app which appearance was chosen. Absent in a desktop app older than this page. */
  setTheme?(mode: "system" | "light" | "dark"): void;
  setWaiting(count: number): void;
  /** The folders on this computer attached to a project: the name agents use, and where each is. */
  folders(projectId: string): Promise<LocalFolder[]>;
  /** Lets the person pick a folder in the system's dialog and attaches it. */
  addFolder(projectId: string): Promise<LocalFolder[]>;
  removeFolder(projectId: string, path: string): Promise<LocalFolder[]>;
  /** Lets the person pick a folder for a project not made yet. Absent in an older desktop app. */
  pickFolder?(): Promise<LocalFolder | null>;
  /** Attaches a folder picked with `pickFolder` to the project made since. */
  attachPicked?(projectId: string, path: string): Promise<LocalFolder[]>;
  /** Says that folders picked with `pickFolder` are not wanted after all. */
  forgetPicked?(paths: string[]): Promise<void>;
  /** Does what an agent asked in the project's folders. */
  local(
    projectId: string,
    tool: string,
    args: Record<string, unknown>,
    /** Which call of which conversation this is. The app checks it with the server and does what the server holds. */
    call?: { conversation: string; id: string },
    /** `skip`: the app has it in hand by another way; the page says nothing for it. */
  ): Promise<{ ok: boolean; text: string; skip?: boolean }>;
  notify(title: string, body: string): void;
  /** What the attached folders are: repositories, their branch and state, their own instructions. Absent in an older desktop app. */
  describe?(projectId: string, conversationId?: string): Promise<FolderNote[]>;
  /** What changed in the project's repositories and is not committed. Absent in an older desktop app. */
  changes?(projectId: string, conversationId?: string): Promise<RepoChanges[]>;
  /**
   * How a conversation's work stands in each repository: its branch, whether it is in a
   * copy of the repository, how far ahead it is, its pull request. Absent in an older desktop app.
   */
  task?(projectId: string, conversationId: string): Promise<TaskNote[]>;
  /** The commands going on in the project. Absent in an older desktop app. */
  jobs?(projectId: string): Promise<JobNote[]>;
  stopJob?(projectId: string, id: string): Promise<void>;
  /** The files of the project's folders, by folder. Absent in an older desktop app. */
  tree?(
    projectId: string,
    conversationId?: string,
  ): Promise<{ name: string; files: string[]; more: boolean }[]>;
  /** One file's text. The path begins with the folder's name. */
  view?(
    projectId: string,
    path: string,
    conversationId?: string,
  ): Promise<{ ok: boolean; text: string }>;
  /** Whether the app answers what agents ask by itself. Absent in an older desktop app. */
  answers?(): Promise<boolean>;
  /** The replies whose file changes can be put back. Absent in an older desktop app. */
  undoable?(projectId: string): Promise<{ reply: string; files: string[] }[]>;
  undo?(projectId: string, reply: string): Promise<string[]>;
  /** Ends the commands a stopped run was waiting on. Absent in an older desktop app. */
  halt?(projectId: string): Promise<void>;
}
export interface RepoChanges {
  name: string;
  branch: string | null;
  files: { path: string; state: string; diff: string; agent?: boolean }[];
  more: number;
}
/** A conversation's work in one repository (apps/desktop/src/task.ts). */
export interface TaskNote {
  name: string;
  branch: string;
  base: string;
  /** The agent works in a copy of the repository: the person's own work is in the folder. */
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
  } | null;
}
export interface JobNote {
  id: string;
  command: string;
  where: string;
  running: boolean;
  seconds: number;
  code: number | null;
  tail: string;
}
export interface FolderNote {
  name: string;
  repository: boolean;
  branch: string | null;
  changed: number | null;
  instructions: { file: string; text: string }[];
  checks?: string[];
}

export const desktop = (window as { musterDesktop?: Desktop }).musterDesktop;
