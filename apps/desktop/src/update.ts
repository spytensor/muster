import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, autoUpdater, type BrowserWindow, dialog } from "electron";
import { feedUrl } from "./server";

/**
 * Keeps the app itself up to date, as desktop apps do: it asks its server now and then
 * whether there is a newer build, fetches it in the background, and offers to restart
 * into it. Most of what changes in Muster is the page the server sends, which needs none
 * of this; this is for the shell around the page.
 *
 * On macOS this is the system's own updater (Squirrel), which installs only a build
 * signed with the same Developer ID as the one running. So only a release asks: the
 * release script leaves a mark in the build (`updates.json`), and a build without it, as
 * one made with `pnpm package`, does nothing here. Without the mark such a build would
 * fetch every release in full, every four hours, only to have the system refuse it.
 * Windows and Linux are not done.
 */
const EVERY = 4 * 60 * 60 * 1000;

export function watchForUpdates(
  server: () => string | null,
  window: () => BrowserWindow | null,
): { check(): void } {
  // A build run from the source tree is not installed anywhere and cannot be replaced;
  // one that is not a release cannot be replaced by one.
  const able =
    app.isPackaged &&
    process.platform === "darwin" &&
    existsSync(join(__dirname, "..", "updates.json"));
  // The newer build that has been fetched and waits for a restart.
  let ready: string | null = null;
  // The person asked: they are told the answer whatever it is.
  let asked = false;
  let busy = false;
  const say = (message: string, detail = "") => {
    const on = window();
    const options = { type: "info" as const, message, detail, buttons: ["OK"] };
    void (on ? dialog.showMessageBox(on, options) : dialog.showMessageBox(options));
  };

  if (able) {
    autoUpdater.on("update-not-available", () => {
      busy = false;
      if (asked) say("Muster is up to date.", `Version ${app.getVersion()}`);
      asked = false;
    });
    autoUpdater.on("error", (error) => {
      busy = false;
      // Said only to someone who asked: a check in the background fails quietly, and
      // tries again later.
      if (asked) say("Could not check for updates.", error.message.slice(0, 300));
      asked = false;
      console.error("checking for updates failed:", error.message);
    });
    autoUpdater.on("update-available", () => {
      // It is being fetched, which may take minutes: someone who asked is told now.
      if (asked)
        say(
          "A newer Muster is being downloaded.",
          "You will be asked to restart when it is ready.",
        );
      asked = false;
    });
    autoUpdater.on("update-downloaded", (_event, _notes, name) => {
      busy = false;
      asked = false;
      ready = name || "update";
      offer();
    });
  }
  /** Offers the restart into what was fetched. */
  const offer = () => {
    {
      const name = ready === "update" ? "" : ready;
      const on = window();
      const options = {
        type: "info" as const,
        message: `Muster ${name || "has an update"} is ready.`,
        detail: "Restart to use it. Nothing in your conversations is lost.",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      };
      void (on ? dialog.showMessageBox(on, options) : dialog.showMessageBox(options)).then(
        // Later: it is installed when the app is next quit.
        (answer) => answer.response === 0 && autoUpdater.quitAndInstall(),
      );
    }
  };

  const check = (byHand: boolean) => {
    const from = server();
    if (!able || !from) {
      if (byHand)
        say(
          "This copy of Muster does not update itself.",
          able ? "It is not connected to a server." : "It was not installed from a signed release.",
        );
      return;
    }
    // Fetched already: nothing more is asked of the server, which would fetch it again.
    if (ready) {
      if (byHand) offer();
      return;
    }
    if (busy) {
      if (byHand)
        say("Muster is already checking for an update.", "You will be told when it is ready.");
      return;
    }
    if (byHand) asked = true;
    busy = true;
    try {
      // Each time: the server may have been changed since the last.
      autoUpdater.setFeedURL({
        url: feedUrl(from, process.platform, process.arch, app.getVersion()),
      });
      autoUpdater.checkForUpdates();
    } catch (error) {
      busy = false;
      console.error("checking for updates failed:", error);
    }
  };
  if (able) {
    // A little after starting, so it is never in the way of the window opening.
    setTimeout(() => check(false), 15_000).unref();
    setInterval(() => check(false), EVERY).unref();
  }
  return { check: () => check(true) };
}
