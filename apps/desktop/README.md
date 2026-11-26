# Muster for the desktop

The Muster workspace in its own window (Electron). It shows the same web app the
server serves, so the desktop, the browser and the phone always agree.

What the desktop app adds:

- **Sign-in through your own browser.** The app never shows a sign-in form. It
  opens the system browser, you sign in there and confirm, and the browser hands
  a one-time code back to the app on `127.0.0.1` (`src/auth.ts`). The code is
  useless without a secret only the app holds.
- **The session is kept in the operating system's keychain** (`src/store.ts`),
  and is sent only to the server the app is connected to (`src/main.ts`).
- **The same ways to sign in as the web.** The sign-in screen lists what the server
  offers ("Sign in with Microsoft"); pressing one opens that provider in the browser.
- **On a Mac the window has no title bar of its own.** The window's buttons sit over
  the sidebar, the page's top rows move the window, and the sidebar is the system's
  own window material rather than a panel drawn inside the window
  (`src/main.ts`, `src/preload.ts`, the `desktop-mac` rules in `apps/web/src/index.css`).
- **The window follows the appearance chosen in the page** (light, dark or the
  device's), from the moment it opens.
- **A count on the app icon** of actions waiting for your approval, and a
  notification when an agent asks for approval or finishes while the window is
  in the background.
- **First run:** a build that names its server (`server.json`) opens on that server's
  sign-in page. One that names none asks for your organization's server address and checks
  that a Muster server answers there. Plain `http` is accepted only for a server
  on this machine.

## Run and build

```bash
pnpm --filter @muster/desktop start      # run from source
pnpm --filter @muster/desktop package    # build apps/desktop/out/Muster-<platform>-<arch>
```

Set `MUSTER_SERVER=http://localhost:5173` to skip the first-run page in development.

A build is for one organisation: `server.json` beside the code names its server, and the
app opens on that server's sign-in page. The first-run page that asks for an address is
shown only when that file is missing or names no address the app would open (`https`, or
`http` on this machine), or when the server cannot be reached. `MUSTER_SERVER` at launch
comes before an address the person chose, which comes before the build's own.

## Not here yet

- **Local runs, sync and offline.** A person can attach folders on this computer
  to a project, and an agent then lists, reads, searches and writes text files in
  them through this app (`src/local.ts`; see `docs/features/clients-and-operations.md`).
  The run itself still happens on the server, Office and PDF files in a folder
  are not read, and nothing works offline. This has not yet been run in the
  packaged app.
- **A menu-bar icon, a global shortcut, and coming back from the browser by itself.**
  After signing in, the browser's page stays open and the person returns to the app.
- **The administrator's console and the sign-in screen keep their own background** on a
  Mac; only the workspace shows the window's material.
- **A build made with `pnpm package` is unsigned** and never updates itself; it is for
  trying the app on the machine that built it.

## Updates

The app keeps itself up to date as desktop apps do (since 2026-11-22; the owner: "APP 更新
系统"): a little after it starts and every four hours it asks its server whether there is
a newer build (`GET /desktop/update`, `src/update.ts`), fetches it in the background, and
asks to restart into it ("Restart" / "Later"; left for later, it is installed when the
app is next quit, which closing its window is not). Only a release asks: a build made
with `pnpm package` carries no mark of one (`updates.json`) and does nothing. The app menu has "Check for Updates…", which says the answer
whatever it is. Most of what changes in Muster is the page the server sends, which needs
none of this; an update is for the shell: this folder.

A release is made on a Mac by `pnpm --filter @muster/desktop run release`
(`scripts/release.mjs`): it builds, signs with the account's "Developer ID Application"
certificate and the hardened runtime, has Apple notarize it, makes one archive
(`Muster-<version>-darwin-<arch>.zip`) and the small file that names it
(`darwin-<arch>.json`), and with `MUSTER_RELEASE_HOST` set copies both into the server's
files (`/data/files/_desktop` in the container). The version is `version` in
`package.json`: a release is offered to an app whose own version is earlier.

What that needs, once, from the holder of the Apple developer account, and that no
script can do for them: a "Developer ID Application" certificate in the keychain of the
Mac that makes releases (an "Apple Development" one does not do), and notarization
credentials kept under the name `muster-notary`
(`xcrun notarytool store-credentials muster-notary --apple-id … --team-id …`).

Not done, and what follows from it:

- No release has been made: until the certificate is there the script stops and says
  so. Nothing here has been seen to update an installed app.
- macOS only, and only the processor of the Mac that made the release (Apple silicon
  here). An Intel Mac, Windows and Linux are offered nothing.
- The copy already installed by hand is unsigned and will not update: the first signed
  release is installed by hand once more, and updates itself from then on.
- The two addresses need no session: anyone who knows the server's address can fetch
  the app. It holds no secret; it does name the server.
- No rollback, no staged release, no check of the archive beyond Apple's signature.
- **Windows and Linux builds** are not tested. Nothing in the code is specific to macOS.

Screens from an end-to-end run against a development server are in `docs/screens/`.
