# Muster for iOS

The Muster workspace on a phone: talk to agents, watch the reply as it is written, approve or
refuse what an agent wants to send, keep documents, and build your own agents. It is the same
product as the web app (`apps/web/src/app`) and talks to the same server API (`/api/app/*`).

Expo SDK 54, React Native 0.81, TypeScript. iOS first.

## How it is put together

| Path | What it is |
| --- | --- |
| `App.tsx` | Navigation: the conversation as the home screen with a drawer beside it, and a sheet with its own stack for Agents, Documents, the Inbox and Settings. No tabs. |
| `src/session.tsx` | Sign-in, sign-out, the server address, language and appearance. |
| `src/lib/api.ts` | Requests with the session token, and the live event stream. |
| `src/lib/pkce.ts`, `sse.ts`, `live.ts`, `risk.ts` | Pure logic, covered by `test/`. |
| `src/files.tsx`, `src/lib/files.ts` | Picking, uploading, opening and listing the person's files. |
| `src/screens/Project.tsx`, `src/lib/lives.ts` | A project to look at: steps, the latest update, and what lives in it (repositories, guides, environments, links, contacts, facts), each row opened with a tap. |
| `src/visuals.tsx`, `src/lib/chart.ts` | Charts drawn natively; diagrams drawn by a bundled copy of Mermaid. |
| `src/numbers.tsx`, `src/lib/visuals.ts` | The other ways a reply shows numbers (component set 4), and their arithmetic. |
| `src/menu.ts`, `menu.ios.ts` | A short list of actions: the system's action sheet on iOS. |
| `src/progress.tsx` | The steps of a reply (one line that opens) and the agent's plan. |
| `src/bars.tsx` | What a list inside the sheet needs to start under its bar and end clear of the home indicator. |
| `src/theme.tsx` | The colours, type scale, radii and press feedback: the design standard below. |
| `src/reply.tsx` | Agent replies (OpenUI Lang) drawn with native components. |
| `src/approval.tsx` | The approval card: the whole address, method, size, everything sent. |
| `src/screens/` | Sign in, Chat (the home screen: a conversation, or the start of one), Drawer (beside it), Inbox (what waits, then what happened), Project (to look at), Documents (with files), a file's text, Agents, Settings. |
| `src/i18n/` | English and Chinese. To add a language, copy `en.ts` and list it in `index.tsx`. |
| `plugins/` | Two build fixes for Xcode 27 (UIScene lifecycle, pod deployment targets). |
| `patches/` | Removes DOM use from `@openuidev/react-lang` so it renders in React Native. |

This app is **outside the pnpm workspace** and has its own npm lockfile. It uses the shared
reply schema through `"@muster/ui-schema": "file:../../packages/ui-schema"`; Metro is set up
(`metro.config.cjs`) to read that package and to resolve what it imports from this app's own
`node_modules`.

## Run it

```bash
# 1. Once, from the repository root: build the shared reply schema.
pnpm --filter @muster/ui-schema build

# 2. Install. Always npm here, never pnpm.
cd apps/mobile
npm install

# 3. A server to talk to. Development mode has sample people and a sign-in page with no password.
#    (From the repository root, in another terminal.)
PORT=7420 MUSTER_PUBLIC_URL=http://localhost:7420 MUSTER_DEV=1 \
  pnpm --filter @muster/server exec tsx src/index.ts
#    Add the MUSTER_MODEL_* variables to let agents run; without them the app says so.

# 4. Run in the simulator with Metro (fast reload).
npx expo run:ios --device "<simulator name or UDID>"
```

If a root `pnpm install` ever rewrites `apps/mobile/node_modules`, delete that folder and run
`npm install` again.

## Build a standalone app for the simulator

A Release build carries its JavaScript inside the app, so it runs without Metro:

```bash
cd apps/mobile
npx expo prebuild -p ios          # writes ios/ (not committed)
xcodebuild -workspace ios/Muster.xcworkspace -scheme Muster -configuration Release \
  -sdk iphonesimulator -destination "id=<simulator UDID>" \
  -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO
xcrun simctl install <simulator UDID> ios/build/Build/Products/Release-iphonesimulator/Muster.app
xcrun simctl launch <simulator UDID> ai.muster.app
```

## Point it at a server

- The default address comes from `extra.serverUrl` in `app.json` (`http://localhost:7420`).
  Set `MUSTER_SERVER_URL=https://muster.example.com` when building to change the default.
- On the sign-in screen, **Change** next to the server address sets another one. It is kept on
  the device, so one build can be used against development and deployed servers.
- A deployed server must use `https`. iOS only allows plain `http` to this machine and the
  local network.
- The server must list `muster://auth` as an allowed app redirect (it does) and its
  `MUSTER_PUBLIC_URL` must be the address the phone can reach.

Sign-in opens the system browser (`ASWebAuthenticationSession`), the person signs in and
confirms, and the app exchanges a one-time code plus its own secret (PKCE) for a session token.
The token is kept in the Keychain (`expo-secure-store`) and sent as `Authorization: Bearer` on
every request. A `401` from anywhere returns the app to the sign-in screen.

## Checks

```bash
cd apps/mobile
npx tsc --noEmit          # types
npm test                  # node --test: PKCE, event-stream parsing, the live event reducer
cd ../.. && pnpm exec biome check apps/mobile
python3 apps/mobile/scripts/make-icons.py   # only to redraw the icon and splash images
```


## Files, charts and diagrams

- **Files.** The paperclip in a message box takes files from the system's file chooser or
  photos from the photo library; each uploads at once, with its progress, and anything the
  server would refuse (a kind it does not accept, or too large) is refused before it is sent,
  with the reason. Documents (in the sheet) lists documents and files together and uploads from its +.
- **Opening a file is native.** The file is downloaded to the app's cache with the session
  token and shown by iOS Quick Look (`react-native-file-viewer-turbo`): Word, Excel, PowerPoint,
  PDF and images look as they do in Apple's own apps. The copy is deleted when the viewer
  closes, when the app next starts, and on sign-out.
- **A web page is never run.** A `.html` file is not given to Quick Look or to a web view; the
  app shows its text from the server (`/api/app/files/:id/text`).
- **Charts** are drawn with `react-native-svg` from the arithmetic in `src/lib/chart.ts`: bar,
  line and area, at most four series in fixed colours, a legend only with two or more series,
  and a "Numbers" switch to a table.
- **Every other way of showing numbers** the shared schema has (component set 4,
  `UI_VERSION` 4, which the app sends with each message) is drawn too, so an agent never has
  to make a picture with code or say it cannot show something. `Chart` has four more kinds:
  bars lying down, stacked parts, a pie (one series, six slices at most, the rest folded into
  "Other") and a radar. `src/numbers.tsx` draws `Scatter`, `Heatmap`, `Tiles` (a market map:
  tiles as large as their weight when every item has one, of one size otherwise), `Candles`,
  `Metrics`, `Progress` and `Timeline`; a `Table` colours the columns the reply marks as
  changes. The arithmetic is in `src/lib/visuals.ts` and is tested (`test/visuals.test.ts`).
  - **Colour says the same thing as the number, never more.** Every tile and cell has its
    number written in it. Where the reply says which colour a rise wears (`up`: red in
    mainland China, Hong Kong, Taiwan, Japan and Korea; green elsewhere), rises and falls are
    two hues from a neutral middle, stronger the further from zero. Without it, one hue from
    light to dark; blue above zero and orange below it if some values are negative. Text on a
    strong fill is white; a coloured change in a table or a headline figure wears the text
    colours `bad` and `ok`.
  - **Nothing is drawn from what is not there.** Each takes only what is really a name or a
    number, caps what it draws (60 tiles, a grid of 20 by 20, 120 candles, 200 points) and
    draws nothing for empty data; a half-written reply never throws.
  - **Second round (2026-11-24), the same on the web.** Two more kinds of `Chart`: `combo`
    is two drawings over the same names, the first series as bars and the others as lines
    below them on a scale of their own that need not start at zero (never two scales on one
    drawing); `waterfall` is the opening amount, each change as a bar from where the last
    ended, and a closing "Total" the app adds. `target` draws a dashed line with its name
    (upright on lying bars). `Scatter` colours dots by `group` (four kinds at most, a legend)
    and sizes them by `size`; a `Metrics` figure may carry a small `trend` line, and its
    change is marked ▲ or ▼ as well as coloured.
  - **`Flows`** (a Sankey of our own, since Mermaid's cannot take Chinese names): boxes and
    bands placed by the layout the web uses (`layoutFlows` and `bandPath` from
    `@muster/ui-schema`), a band in the colour of the source it began at, names beside
    their boxes with the amount after them, and a "Numbers" switch listing each flow.
  - **How numbers are written.** Beside a mark and in the table: whole, two decimals at
    most (`plain`). On an axis only: 万 and 亿 in Chinese, K, M and B otherwise (`compact`).
    A unit that begins with a sign of money leads the number (`withUnit`: "$1,200").
    A missing number keeps its place: no bar, a break in the line, an empty cell.
  - **How much is kept.** Upright bars, stacks, combos and waterfalls keep the latest 60
    labels; lines and areas the latest 240; lying bars the first 30; a radar the first 12
    (`kept`, `src/lib/visuals.ts`). A name under a bar is cut by the room it has, a Chinese
    character counting for two (`fitLabel`). Tests: `test/visuals2.test.ts`.
- **Diagrams** are Mermaid source. Mermaid needs a browser page to lay a diagram out, so it runs
  in a `react-native-webview` that holds one page: a copy of Mermaid written into
  `src/vendor/diagram-page.js` at install time (`scripts/make-diagram-page.mjs`; not in git).
  The page's own rule (Content-Security-Policy `default-src 'none'`) lets it load nothing, the
  view may navigate nowhere, and Mermaid draws in `securityLevel: "strict"`. Source that does
  not parse, or a page that does not answer within eight seconds, is shown as source.
  `beautiful-mermaid` (no DOM) was the other choice; it does not draw gantt charts or mind maps,
  which agents are told they may write, and its SVG relies on CSS that `react-native-svg`
  does not apply, so the web view was chosen for drawing the same diagrams as the web app.

## What a careful buyer should know

- The session token is in the Keychain, readable only while the device is unlocked, and is not
  included in backups or moved to another device. Signing out ends the session on the server
  and removes the token, the default agent and every downloaded file.
- Settings shows each place the account is signed in and can sign any of them out.
- While the app is not in front, a cover replaces the screen, so the app switcher does not show
  a conversation.
- The sign-in screen warns when the server address is not `https`.
- Not there: an app lock (Face ID), certificate pinning, configuration by a device-management
  system, and a way to stop Quick Look's share button from sending a file to another app.
  Copying a reply puts it on the system clipboard like any other copy.

## Design rules the screens follow

Since 2026-11-17 (CHA-260) the app follows one design standard, at the owner's
word: "no row of tabs at the bottom". The tokens are in `src/theme.tsx`.

- **No tabs. The conversation is the home screen** (`src/screens/Chat.tsx`). It opens on the
  person's latest conversation, or on the start of their first.
- **The layout is the one people know** (CHA-261, at the owner's word, from ChatGPT for iOS).
  Over the top of the conversation float three things: a round button on the left with
  Apple's sign for a sidebar, one
  pill in the middle that names the agent (with a dot, lit when connected and able to
  answer, and a word while it replies; tapping it renames or deletes the conversation), and a
  round button for a new conversation on the right.
- **The drawer** (`src/screens/Drawer.tsx`). The menu button, or a swipe from the left edge,
  moves the conversation aside to the right and uncovers the drawer under it; a touch on the
  conversation puts it back. The drawer is a flat list, no cards: "Muster" and a
  round search button; Agents, Documents and the Inbox (with the number waiting); the
  conversations by day as plain titles, the one in front in bold, a long press to rename or
  delete; at the bottom a "New" pill and the person's initials, which open Settings.
- **Agents, Documents, the Inbox and Settings open as a sheet** with a stack of its own
  (`App.tsx`): what they open is pushed inside it, and a close button is at its top left.
- **+ in the message box opens a glass menu above it** (Photos, Files), not the system's
  action sheet.
- **The message box opens up when the person is in it.** At rest it is one capsule: +, the
  text, send. With the cursor in it, it is a taller rounded box with the text above and the
  two buttons under it, and it sits against the keyboard.
- **The start of a new conversation is an empty page**: the pill, the message box, and
  nothing between them. Who answers is not chosen before speaking: it is the person's
  usual agent (set in Settings), and the pill says only "Muster" — or the agent's name
  when it was called from its row in Agents. (A list of agents at the foot of the page,
  then a menu from the pill, were tried and taken out at the owner's word: choosing who
  to talk to first is how such apps were made years ago.)
- **Pages inside the sheet are lists, never forms** (CHA-261, after the owner's "no UI design
  at all"). Settings: the person's initials, name and address at the top, then grouped rows
  of a small mark, a name, what it is now and an arrow; a choice among a few is a menu on
  the row; what is typed (working hours, how answers should read, the signature) and usage
  each have a page of their own (`SettingPart`). Agents: one row an agent (initial, name, two
  lines of what it is for; "Acts externally" only when it does), a touch starts a
  conversation, "…" edits or deletes one of the person's own. The agent editor: the initial,
  the name and purpose typed in place, the instructions in one card, what it may use grouped
  by kind (Documents, Files, Web, Microsoft 365, More) with short words and the system's
  switch, and "Save" in the bar. Documents and the Inbox say an empty state once, in the
  middle, with its sign.
- **Black and white.** The page is pure white or pure black with the system. Surfaces are
  flat and opaque: no shadows, a hairline border, continuous corners (cards and grouped lists
  20, inputs 18, controls 14, pills). Primary actions are black on white or white on black.
  The one accent is Muster's own blue, used sparingly: a link, the person's
  initial, a mark. Colour otherwise says what something is: waiting, wrong, done.
- **The chat is plain.** What an agent writes is full-width text, 16/25, with no bubble. The
  person's message is a soft bubble (radius 22) on the right. The message box is one glass
  capsule: + for a file, the text, and a round send button in the primary colour that turns
  into stop while a reply is written.
- **Glass only floats.** The pill, the round button and the message box are translucent
  (`Glass` in `src/ui.tsx`): Liquid Glass where iOS has it, a blur on older iOS, a solid
  surface elsewhere or with Reduce Transparency. Content is never glass. The page fades out
  under the pill so text scrolls away instead of colliding with it.
- **Grouped lists are inset cards** under a small 13/600 grey header (`Group`, `Row`,
  `SectionTitle` in `src/ui.tsx`), never the system's grey form.
- **Type.** The system font only. 19 for the one title of an empty screen, 17 for a card's
  title, 16 for what is read, 15 for rows and buttons, 13 for everything said beside or under
  something else, 11 for the smallest notes.
- **Pressing fades, never scales** (`PRESSED` in `src/theme.tsx`).
- **Progress is visible.** The steps of a reply are one line ("4 steps") that opens to rows with
  status, action, subject and duration; it is open, with the current step turning, while the
  agent works. The agent's plan is a checklist pinned above the message box while it works, and
  one line ("Plan · 4 of 4 done") in the finished reply.
- A follow-up chip shows exactly the text it sends, and an approval shows the whole address and
  the whole body.

Of that standard, not taken yet: SF Symbols (the icons are still Ionicons' outline set),
haptics, layout animations (`react-native-reanimated`; the drawer's slide is the one spring,
with React Native's own `Animated`), and `react-native-keyboard-controller`. Each needs a native
module the app does not have.

After adding a native module, run `pod install` in `ios/` (or `npx expo prebuild -p ios --clean`):
a plain `expo prebuild` on an existing `ios/` folder does not install the new pod.

## What has been verified, and what has not

Done on 2026-11-14:

- `tsc`, the unit tests (41) and Biome are clean; Metro bundles the app; a Release build for the
  simulator succeeds with Xcode 27.2 with every native module linked (Quick Look viewer, SVG,
  web view, pickers, file system, blur, glass) and embeds `main.jsbundle`.
- The app's own client code (`src/lib/*.ts`) was run from Node against a development server:
  sign-in; upload, with a wrong kind and a file whose content does not match its name refused;
  a message with an attachment; an agent reading the file and making a `.docx`; the download
  being a valid zip; a reply with a Chart and a Diagram parsed against the shared schema;
  rename; sessions; usage; clear history.
- The diagram page was loaded in a desktop browser: flowchart with subgraphs, sequence, state,
  gantt, mind map and ER diagrams draw; source that is not a diagram is reported; a label
  carrying markup and a `click` with a `javascript:` address do nothing; the page cannot fetch
  or load an image from anywhere.

Done on 2026-11-17 (CHA-259, CHA-260), in the iOS 27 simulator (iPhone 17 Pro) with a Debug
build and Metro, against a development server with sample people and no model:

- Sign-in through the system browser; landing on the latest conversation.
- The menu button moving the conversation aside and uncovering the drawer (CHA-261); a
  conversation chosen from the drawer; Agents opened from it as a sheet, and a touch on an agent's row
  starting a new conversation with it; the start page, empty, its pill saying "Muster";
  the + menu over the message box; the message box opening up with the cursor
  in it and sitting against the keyboard, light and dark for the drawer. Before CHA-261, with the sheet that the
  drawer replaced: the edge swipe, Documents and Settings inside the sheet and back.
- Dark and light.
- Before CHA-261, in the sheet: a long press on a conversation offering Rename and Delete;
  deleting the conversation in front, after which the home screen is the start of a new one.
- Settings → How you work: hours 22:00 to 06:00 kept, working days, answer style and
  signature saved; the fields scroll clear of the keyboard.

**Not seen yet:** a reply being written (the server used had no model), so not the stop
button, the pinned plan, a chart, a diagram or an approval card in the new look; Quick Look
opening a file; the pickers; Chinese; the agent and document editors; rename; a message
that fails to send being put back in the box; a real device.

## What is not there yet, and why

- **Notifications of any kind.** An approval that arrives while the app is closed is only seen
  when the app is opened (the number on the pill and in the drawer is counted again then). iOS suspends the app
  seconds after it leaves the front, which ends the live connection, so a local notification
  could only ever fire in those few seconds: switches for it would promise something the app
  cannot do. Real notifications need push: the owner's Apple developer account (APNs key) and a
  server endpoint to register devices; neither exists.
- **Photos in HEIC.** The server accepts png, jpg, gif and webp. The photo picker is asked for a
  compatible copy (JPEG); a photo that still arrives as HEIC is refused with the reason.
- **Trying a failed reply again** sends the last message's words again, without its files, as
  the web app does.
- **TestFlight and App Store builds.** They need the owner's Apple developer team for signing.
  Only simulator builds have been made. No EAS project is configured.
- **Android.** Nothing in the code is iOS-only except the two build plugins, but no Android
  build has been made or tried, so there is no `android` script.
- **iPad layout.** The app is phone-only (`supportsTablet: false`).
- **Administrator features.** Approving a pending agent, the roster and traces stay in the web
  console.
- **Offline use.** Nothing is cached; every screen reads the server.
- **A list that updates by itself.** The conversation list and the approvals badge refresh when
  a screen comes into view, on pull-to-refresh, and when the app returns to the front. Only an
  open conversation is live.
