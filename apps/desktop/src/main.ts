import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  session,
  shell,
} from "electron";
import { newChallenge, redeem, type Waiting, waitForCode } from "./auth";
import { attachable, LocalError, rootNames } from "./local";
import { watchForUpdates } from "./update";
import {
  type Bench,
  changes,
  describe,
  endAll,
  halt,
  jobsOf,
  newBench,
  stopJob,
  toolEnv,
  tree,
  view,
} from "./bench";
import { copiesOf, notesOf, rootsFor, tidy, watchPrs } from "./task";
import { doCall, undoableFor, undoFor } from "./work";
import {
  cleanServer,
  copiesDir,
  readFolders,
  readServer,
  readTheme,
  readToken,
  saveFolders,
  saveServer,
  saveTheme,
  saveToken,
  taskStore,
} from "./store";

let server: string | null = null;
let token: string | null = null;
/** The app's own connection for what agents ask of this computer, begun again whenever the server or the session changes. */
let watching: AbortController | null = null;
let connected = false;
let watch: () => void = () => undefined;
let window: BrowserWindow | null = null;
let signingIn: Waiting | null = null;

const setupPage = join(__dirname, "..", "assets", "setup.html");
const fromServer = (url: string) => server !== null && url.startsWith(`${server}/`);
/** A request from a page is honoured only when the page is the server's, or this app's own first-run page. */
const setupUrl = pathToFileURL(setupPage).href;
const trusted = (url: string) => fromServer(url) || url.split("?")[0] === setupUrl;

function show(): void {
  if (!window) return;
  if (server) void window.loadURL(`${server}/`);
  else void window.loadFile(setupPage);
}

/** What is behind the page before it draws: the page's own colour, light or dark. */
const backdrop = (dark: boolean) => (dark ? "#000000" : "#f7f7f8");
const mac = process.platform === "darwin";

function createWindow(): void {
  // The window and the system's material follow the appearance chosen in the page.
  nativeTheme.themeSource = readTheme();
  const dark = nativeTheme.shouldUseDarkColors;
  window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    title: "Muster",
    // On a Mac the window is the system's own sidebar material and the page lets it show
    // through; elsewhere it is the page's colour, so the window is never white behind a dark page.
    ...(mac
      ? {
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
        }
      : { backgroundColor: backdrop(dark) }),
    // Shown once the page has drawn, so the window never opens empty.
    show: false,
    // On a Mac the page reaches the top of the window and the window's buttons sit over it.
    ...(mac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.on("closed", () => {
    window = null;
  });
  window.once("ready-to-show", () => window?.show());
  // A server that takes the connection and says nothing never draws: the window shows anyway.
  const made = window;
  setTimeout(() => {
    if (!made.isDestroyed() && !made.isVisible()) made.show();
  }, 1500);
  // The page leaves room for the window's buttons, and takes it back in full screen.
  const tellFull = () =>
    window?.webContents.send("muster:full-screen", window?.isFullScreen() ?? false);
  window.on("enter-full-screen", tellFull);
  window.on("leave-full-screen", tellFull);
  window.webContents.on("did-finish-load", tellFull);
  // The window shows Muster and nothing else: other addresses open in the person's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (trusted(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  // A redirect is a navigation too, and gets the same answer.
  // Of the window itself: a page shown inside it may be sent on by its own server, and where
  // it may go is for the page's own rules (what may be framed) to say.
  window.webContents.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && !trusted(url)) event.preventDefault();
  });
  // The server could not be reached: say so on the first-run page instead of a blank window.
  window.webContents.on("did-fail-load", (_event, code, _text, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && fromServer(url))
      void window?.loadFile(setupPage, { query: { unreachable: server ?? "" } });
  });
  show();
}

async function signIn(provider?: unknown): Promise<boolean> {
  if (!server) return false;
  signingIn?.cancel();
  const { verifier, challenge } = newChallenge();
  const waiting = await waitForCode();
  signingIn = waiting;
  const start = new URL(`${server}/auth/app/start`);
  start.searchParams.set("challenge", challenge);
  start.searchParams.set("redirect", waiting.redirect);
  // Which way of signing in the person pressed. The server ignores one it does not offer.
  if (typeof provider === "string" && /^[a-z0-9_-]{1,40}$/.test(provider))
    start.searchParams.set("provider", provider);
  await shell.openExternal(start.toString());
  const code = await waiting.code;
  if (signingIn === waiting) signingIn = null;
  if (!code) return false;
  const granted = await redeem(server, code, verifier).catch(() => null);
  if (!granted) return false;
  token = granted;
  saveToken(token);
  watch();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  return true;
}

/**
 * Folders the person picked in the system's dialog for a project not made yet, with the
 * server they were picked under and when. Only these can be attached afterwards, under
 * that server and for a few minutes; signing out forgets them.
 */
const chosen = new Map<string, { server: string; at: number }>();
const CHOSEN_MS = 10 * 60_000;

async function signOut(): Promise<void> {
  chosen.clear();
  if (server && token) {
    await fetch(`${server}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  token = null;
  saveToken(null);
  watch();
  app.setBadgeCount(0);
}

app.setName("Muster");
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});

void app.whenReady().then(() => {
  server = readServer();
  token = readToken();

  // Every request Muster's own page sends to the server carries the session. Nothing else
  // does: not a page shown inside it (the preview of a dev server is somebody's code, and
  // must not be able to speak to the server as the person), nor a frame within such a page.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, respond) => {
    const headers = details.requestHeaders;
    const frame = details.frame;
    const own =
      // The window's own document as it is fetched, or something its own page asks for.
      details.resourceType === "mainFrame" ||
      (frame != null && frame.parent === null && fromServer(frame.url));
    if (token && own && fromServer(details.url)) headers.Authorization = `Bearer ${token}`;
    // A request that did not come from Muster's own page never carries the session, whoever set it.
    else if (fromServer(details.url)) {
      for (const name of Object.keys(headers))
        if (name.toLowerCase() === "authorization") delete headers[name];
    }
    respond({ requestHeaders: headers });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, allow) =>
    allow(false),
  );

  const guard =
    <A extends unknown[], R>(handle: (...args: A) => R) =>
    (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, ...args: A) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("not allowed");
      return handle(...args);
    };
  ipcMain.handle("muster:sign-in", guard(signIn));
  ipcMain.handle("muster:sign-out", guard(signOut));
  ipcMain.handle(
    "muster:server",
    guard(() => server),
  );
  ipcMain.handle(
    "muster:set-server",
    guard(async (address: string) => {
      const cleaned = cleanServer(String(address));
      if (!cleaned) return "invalid";
      try {
        // A Muster server answers this with the list of ways to sign in.
        const response = await fetch(`${cleaned}/auth/providers`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok || !Array.isArray(await response.json())) return "not_muster";
      } catch {
        return "unreachable";
      }
      await signOut();
      server = cleaned;
      saveServer(server);
      watch();
      show();
      return null;
    }),
  );
  ipcMain.handle(
    "muster:change-server",
    guard(async () => {
      await signOut();
      server = null;
      saveServer(null);
      watch();
      show();
    }),
  );
  // ---- folders on this computer, attached to a project ----
  // Only the server's own pages may ask, and only for folders the person picked in the
  // system's own dialog: a page can never name a path.
  const projectId = (value: unknown) => {
    const id = String(value);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("not a project");
    return id;
  };
  const fromApp =
    <A extends unknown[], R>(handle: (...args: A) => R) =>
    (event: Electron.IpcMainInvokeEvent, ...args: A) => {
      if (!server || !fromServer(event.senderFrame?.url ?? "")) throw new Error("not allowed");
      // The window's own page only: a frame inside it, whatever its address, does not ask.
      if (event.senderFrame !== event.sender.mainFrame) throw new Error("not allowed");
      return handle(...args);
    };
  const named = (project: string) =>
    [...rootNames(readFolders(server as string, project)).entries()].map(([name, path]) => ({
      name,
      path,
    }));
  ipcMain.handle(
    "muster:folders",
    fromApp((project: unknown) => named(projectId(project))),
  );
  /** The folder the person picks in the system's dialog, if it is one that may be attached. */
  const choose = async (): Promise<string | null> => {
    const picked = window
      ? await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] })
      : { canceled: true, filePaths: [] };
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return null;
    if (!attachable(path, app.getPath("home"), app.getPath("userData"))) {
      if (window)
        await dialog.showMessageBox(window, {
          type: "warning",
          message: "That folder cannot be attached",
          detail:
            "It is your home folder, something above it, or where this computer keeps passwords and app data. Choose the folder the work is in.",
        });
      return null;
    }
    return path;
  };
  const attach = (id: string, path: string) => {
    const now = readFolders(server as string, id);
    if (!now.includes(path)) saveFolders(server as string, id, [...now, path].slice(0, 20));
  };
  ipcMain.handle(
    "muster:add-folder",
    fromApp(async (project: unknown) => {
      const id = projectId(project);
      const path = await choose();
      if (path) attach(id, path);
      return named(id);
    }),
  );
  // A project being made has no id yet, and its folders are picked before it has one.
  // What was picked is remembered here, and only that can be attached afterwards: the
  // page still never names a path the person did not choose in the system's dialog.
  ipcMain.handle(
    "muster:pick-folder",
    fromApp(async () => {
      const path = await choose();
      if (!path) return null;
      for (const [old, { at }] of chosen) if (Date.now() - at > CHOSEN_MS) chosen.delete(old);
      chosen.set(path, { server: server as string, at: Date.now() });
      // Bounded: a person picks a few, not thousands.
      if (chosen.size > 40) for (const old of [...chosen.keys()].slice(0, 20)) chosen.delete(old);
      return { name: basename(path), path };
    }),
  );
  ipcMain.handle(
    "muster:attach-picked",
    fromApp((project: unknown, path: unknown) => {
      const id = projectId(project);
      const asked = String(path);
      const pick = chosen.get(asked);
      if (!pick || pick.server !== server || Date.now() - pick.at > CHOSEN_MS) {
        chosen.delete(asked);
        throw new Error("not picked");
      }
      attach(id, asked);
      // Spent only once it is attached: a failure leaves it to be tried again.
      chosen.delete(asked);
      return named(id);
    }),
  );
  // Taken off the list again, or the dialog closed without making the project: what was
  // picked is no longer what the person wants attached.
  ipcMain.handle(
    "muster:forget-picked",
    fromApp((paths: unknown) => {
      for (const path of Array.isArray(paths) ? paths : []) chosen.delete(String(path));
    }),
  );
  ipcMain.handle(
    "muster:remove-folder",
    fromApp((project: unknown, path: unknown) => {
      const id = projectId(project);
      saveFolders(
        server as string,
        id,
        readFolders(server as string, id).filter((item) => item !== String(path)),
      );
      return named(id);
    }),
  );
  /** The calls this app has already begun, by conversation and call. The oldest are forgotten first. */
  const started = new Set<string>();
  const keyOf = (ref: unknown): string | null => {
    const { conversation, id } = (ref ?? {}) as { conversation?: unknown; id?: unknown };
    return typeof conversation === "string" && typeof id === "string"
      ? `${conversation}\u0000${id}`
      : null;
  };
  const begin = (key: string) => {
    started.add(key);
    // A call is over within minutes: thousands back is long over.
    if (started.size > 5000) for (const old of [...started].slice(0, 1000)) started.delete(old);
  };
  /** A call an agent made, as the server holds it while it waits. Null when the server knows of none. */
  const asked = async (
    ref: unknown,
  ): Promise<{
    tool: string;
    args: Record<string, unknown>;
    reply?: string;
    title?: string;
    changes?: boolean;
  } | null> => {
    const { conversation, id } = (ref ?? {}) as { conversation?: unknown; id?: unknown };
    if (
      !server ||
      !token ||
      typeof conversation !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(conversation) ||
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 200
    )
      return null;
    try {
      const response = await fetch(
        `${server}/api/app/conversations/${conversation}/device/${encodeURIComponent(id)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        tool?: unknown;
        args?: unknown;
        reply?: unknown;
        title?: unknown;
        changes?: unknown;
      };
      return typeof body.tool === "string" && body.args !== null && typeof body.args === "object"
        ? {
            tool: body.tool,
            args: body.args as Record<string, unknown>,
            ...(typeof body.reply === "string" ? { reply: body.reply } : {}),
            // What the conversation is called (its work's branch is named after it), and
            // whether the server read the call as one that may change something.
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.changes === "boolean" ? { changes: body.changes } : {}),
          }
        : null;
    } catch {
      return null;
    }
  };
  // What each project's work here holds between calls: which files the agent has seen,
  // and the commands that are going (CHA-273).
  const benches = new Map<string, Bench>();
  const benchOf = (project: string) => {
    const key = `${server}\u0000${project}`;
    let bench = benches.get(key);
    if (!bench) {
      bench = newBench();
      benches.set(key, bench);
    }
    return bench;
  };
  app.on("before-quit", () => {
    for (const bench of benches.values()) endAll(bench);
  });
  // The work conversations have under way in the repositories: its branch, and the copy
  // of a repository it is in when the person's own work is in the folder (task.ts).
  const tasks = taskStore();
  const conversationId = (value: unknown) =>
    typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  /** The folders as a conversation works in them: each attached folder, or its copy of it. */
  const foldersFor = (project: string, conversation: unknown) =>
    rootsFor(
      tasks,
      server as string,
      conversationId(conversation),
      readFolders(server as string, project),
    );
  // What is over is put away: at the start, and now and then while the app runs.
  const putAway = () => void tidy(tasks).catch(() => undefined);
  putAway();
  setInterval(putAway, 30 * 60_000).unref();
  // What the attached folders are: repositories, their branch and state, their own instructions.
  ipcMain.handle(
    "muster:describe",
    fromApp((project: unknown, conversation?: unknown) =>
      describe(foldersFor(projectId(project), conversation)),
    ),
  );
  // What the person looks at beside a conversation: what changed in the repositories, and
  // the commands that are going (CHA-274).
  ipcMain.handle(
    "muster:changes",
    fromApp((project: unknown, conversation?: unknown) => {
      const id = projectId(project);
      return changes(foldersFor(id, conversation), benchOf(id));
    }),
  );
  // How a conversation's work stands in each repository: its branch, how far ahead, its
  // pull request. The service is asked about a pull request no more than every 45 seconds.
  ipcMain.handle(
    "muster:task",
    fromApp(async (project: unknown, conversation: unknown) => {
      const id = projectId(project);
      const of = conversationId(conversation);
      if (!of) return [];
      const roots = readFolders(server as string, id);
      await watchPrs({
        store: tasks,
        server: server as string,
        conversation: of,
        roots,
        env: toolEnv(),
      }).catch(() => undefined);
      return notesOf(tasks, server as string, of, roots);
    }),
  );
  ipcMain.handle(
    "muster:jobs",
    fromApp((project: unknown) => jobsOf(benchOf(projectId(project)))),
  );
  ipcMain.handle(
    "muster:stop-job",
    fromApp((project: unknown, id: unknown) => stopJob(benchOf(projectId(project)), String(id))),
  );
  // The attached folders' files, and one file's text, for the person to look at (CHA-274).
  ipcMain.handle(
    "muster:tree",
    fromApp((project: unknown, conversation?: unknown) =>
      tree(foldersFor(projectId(project), conversation)),
    ),
  );
  ipcMain.handle(
    "muster:view",
    fromApp(async (project: unknown, path: unknown, conversation?: unknown) => {
      try {
        return {
          ok: true,
          text: await view(foldersFor(projectId(project), conversation), String(path)),
        };
      } catch (error) {
        return {
          ok: false,
          text: error instanceof LocalError ? error.message : "That file could not be read.",
        };
      }
    }),
  );
  // The replies whose file changes can be put back, and putting one back (CHA-274).
  ipcMain.handle(
    "muster:undoable",
    fromApp((project: unknown) => {
      const id = projectId(project);
      return undoableFor(readFolders(server as string, id), benchOf(id));
    }),
  );
  ipcMain.handle(
    "muster:undo",
    fromApp((project: unknown, reply: unknown) => {
      const id = projectId(project);
      const folders = readFolders(server as string, id);
      return undoFor(
        folders,
        benchOf(id),
        String(reply),
        copiesOf(tasks, server as string, folders),
      );
    }),
  );
  // Whether this app answers what agents ask by itself, so that the page need not.
  ipcMain.handle(
    "muster:answers",
    fromApp(() => connected),
  );

  /**
   * What agents ask of this computer is answered by the app itself, over its own
   * connection to the server (CHA-275): the conversation's page need not be in front, or
   * open at all. The server says which call; what the call is, is asked for as always.
   */
  const carryOut = async (ask: { conversation?: unknown; project?: unknown; id?: unknown }) => {
    const ref = { conversation: ask.conversation, id: ask.id };
    const key = keyOf(ref);
    if (!key || started.has(key)) return;
    begin(key);
    // The server and session of now: a call is answered where it was asked.
    const at = server;
    const with_ = token;
    const call = await asked(ref);
    if (!call) {
      // Not told: the call is over, or the server could not be reached. If it still
      // waits, whoever hears of it next may try; the server tells it only once.
      started.delete(key);
      return;
    }
    let answer: { ok: boolean; text: string };
    try {
      const project = typeof ask.project === "string" ? projectId(ask.project) : null;
      if (!project)
        throw new LocalError(
          "This conversation is not in a project, so no folder on this computer is attached to it.",
        );
      answer = {
        ok: true,
        text: await doCall(
          {
            store: tasks,
            home: copiesDir(),
            server: at as string,
            conversation: conversationId(ref.conversation),
            title: call.title ?? "",
            folders: readFolders(at as string, project),
            bench: benchOf(project),
            env: toolEnv(),
          },
          call,
        ),
      };
    } catch (error) {
      answer = {
        ok: false,
        text:
          error instanceof LocalError ? error.message : "That could not be done on this computer.",
      };
    }
    // What was done is said, and said again if the first telling did not arrive: an agent
    // that hears nothing may do it a second time.
    for (let attempt = 0; attempt < 4; attempt++) {
      const told = await fetch(
        `${at}/api/app/conversations/${ref.conversation}/device/${encodeURIComponent(String(ref.id))}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${with_}`, "content-type": "application/json" },
          body: JSON.stringify({ ok: answer.ok, text: answer.text.slice(0, 380_000) }),
        },
      ).catch(() => null);
      // Answered, or no longer waited for: either way there is nothing more to say.
      if (told && told.status < 500) return;
      await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt));
    }
  };
  watch = () => {
    watching?.abort();
    connected = false;
    if (!server || !token) return;
    const controller = new AbortController();
    watching = controller;
    const at = server;
    const with_ = token;
    const mine = () => watching === controller;
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
    void (async () => {
      let wait = 1000;
      while (!controller.signal.aborted) {
        // The server says something at least every 25 seconds. A connection that has said
        // nothing for a minute is dead, whatever it looks like, and is made again: the
        // server then tells again of every call still waiting.
        const attempt = new AbortController();
        const giveUp = () => attempt.abort();
        controller.signal.addEventListener("abort", giveUp, { once: true });
        let quiet = setTimeout(giveUp, 60_000);
        try {
          const response = await fetch(`${at}/api/app/device/events`, {
            headers: { authorization: `Bearer ${with_}`, accept: "text/event-stream" },
            signal: attempt.signal,
          });
          // A server older than this app, or a session that ended: nothing is heard this way.
          if (!response.ok || !response.body) throw new Error("no stream");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let held = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            clearTimeout(quiet);
            quiet = setTimeout(giveUp, 60_000);
            // Connected once something has in fact arrived.
            if (mine()) connected = true;
            wait = 1000;
            held += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            for (let cut = held.indexOf("\n\n"); cut >= 0; cut = held.indexOf("\n\n")) {
              const block = held.slice(0, cut);
              held = held.slice(cut + 2);
              const data = /^data: ?(.*)$/m.exec(block)?.[1];
              if (/^event: ?ask$/m.test(block) && data) {
                try {
                  void carryOut(JSON.parse(data));
                } catch {}
              }
            }
          }
        } catch {}
        clearTimeout(quiet);
        controller.signal.removeEventListener("abort", giveUp);
        if (mine()) connected = false;
        if (controller.signal.aborted) return;
        await pause(wait);
        wait = Math.min(wait * 2, 30_000);
      }
    })();
  };
  watch();
  // A run was stopped: the commands it was waiting on are ended. Jobs go on.
  ipcMain.handle(
    "muster:halt",
    fromApp((project: unknown) => halt(benchOf(projectId(project)))),
  );
  ipcMain.handle(
    "muster:local",
    fromApp((project: unknown, _tool: unknown, _args: unknown, ref: unknown) => {
      // The page only says which call it is. The app asks the server what the call is, does
      // it, and answers the server itself, exactly as for a call it heard of over its own
      // connection: a page that was tampered with, reloaded or closed changes nothing.
      const { conversation, id } = (ref ?? {}) as { conversation?: unknown; id?: unknown };
      void carryOut({ conversation, id, project: projectId(project) });
      return { ok: false, text: "", skip: true };
    }),
  );
  ipcMain.on(
    "muster:theme",
    guard((mode: unknown) => {
      if (mode !== "system" && mode !== "light" && mode !== "dark") return;
      nativeTheme.themeSource = mode;
      if (!mac) window?.setBackgroundColor(backdrop(nativeTheme.shouldUseDarkColors));
      if (readTheme() !== mode) saveTheme(mode);
    }),
  );
  ipcMain.on(
    "muster:waiting",
    guard((count: number) => {
      app.setBadgeCount(Number.isInteger(count) && count > 0 ? Math.min(count, 99) : 0);
    }),
  );
  ipcMain.on(
    "muster:notify",
    guard((title: string, body: string) => {
      if (!window || window.isFocused() || !Notification.isSupported()) return;
      const note = new Notification({
        title: String(title).slice(0, 80),
        body: String(body).slice(0, 200),
      });
      note.on("click", () => {
        window?.show();
        window?.focus();
      });
      note.show();
    }),
  );

  const updates = watchForUpdates(
    () => server,
    () => window,
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // The system's own app menu, with one line of ours where such a line always is.
      ...(process.platform === "darwin"
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" as const },
                { label: "Check for Updates…", click: () => updates.check() },
                { type: "separator" as const },
                { role: "services" as const },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : []),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "togglefullscreen" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else window?.show();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
