import {
  BarChart3Icon,
  BookOpenIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  InboxIcon,
  LogOutIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PencilIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SquarePenIcon,
  StoreIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { goApp, signOut } from "@/App";
import { Mark, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Lead } from "@/components/ui/hint";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/i18n";
import { api, type Me } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notify";
import { address, cn } from "@/lib/utils";
import { MyAgents } from "./AgentsPage";
import {
  type Approval,
  type Attachment,
  type ConversationSummary,
  type DocumentSummary,
  type FileItem,
  type Project,
  worksIn,
} from "./api";
import { type Bar, Chat, PaneBar, type Side } from "./Chat";
import { markSeen, seenPlaces } from "./discovery";
import { FileViewer, OpenFileProvider } from "./FileViewer";
import { Inbox } from "./Inbox";
import { MyKnowledge } from "./Knowledge";
import { MyDocuments } from "./Library";
import { Marketplace } from "./Market";
import { ProjectPage } from "./ProjectPage";
import { ProjectDialog, preferProject, preferredProject } from "./Projects";
import { MySchedules } from "./Schedules";
import { Settings, type SettingsSection } from "./Settings";
import { MySkills } from "./Skills";

type View =
  | "chat"
  | "approvals"
  | "documents"
  | "agents"
  | "knowledge"
  | "market"
  | "notices"
  | "schedules"
  | "project";
const PANEL_KEY = "muster.panel";
const SIDEBAR_KEY = "muster.sidebar";
const PANE_VIEW_KEY = "muster.pane";
const DAY = 86_400_000;

/** The document title carried in an address, or null when there is none or it is not readable. */
function titleIn(part: string | undefined): string | null {
  try {
    return part ? decodeURIComponent(part) : null;
  } catch {
    return null;
  }
}

/** Where the person works: conversations with agents, their documents, and what waits for them. */
export function Workspace({ me, path }: { me: Me; path: string[] }) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  // The sidebar put away, by the person, to give the work the whole window (the owner,
  // 2026-11-22: "现在没有支持用户折叠的功能"). Kept, so it stays away until they bring it back.
  const [hidden, setHidden] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "folded");
  const fold = (away: boolean) => {
    localStorage.setItem(SIDEBAR_KEY, away ? "folded" : "shown");
    setHidden(away);
  };
  const foldRef = useRef({ hidden, fold });
  foldRef.current = { hidden, fold };
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  /** The menu of a narrow window is being opened for its search box. */
  const wantsBox = useRef(false);
  // The usual shortcuts: Command or Control with comma for settings, with K for the search,
  // and for a new conversation Shift and O — the one a browser leaves free — and, in the
  // desktop app, N as well (CHA-262).
  useEffect(() => {
    // Command on a Mac, Control elsewhere, and never both: on a Mac, Control with N or K
    // moves the cursor and cuts a line in a text field, and must keep doing so.
    const mac = navigator.platform.startsWith("Mac");
    const box = () =>
      [...document.querySelectorAll<HTMLInputElement>("input[data-find]")].find(
        (one) => one.offsetParent !== null,
      );
    const onKey = (event: KeyboardEvent) => {
      if ((mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) || event.altKey)
        return;
      const key = event.key.toLowerCase();
      if (key === "," && !event.shiftKey) {
        event.preventDefault();
        setSettings((now) => now ?? "account");
        return;
      }
      // Under an open dialog (settings, a file) nothing moves; the menu of a narrow window is
      // a dialog too, and holds the search box.
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog && !dialog.querySelector("input[data-find]")) return;
      if (key === "k" && !event.shiftKey) {
        event.preventDefault();
        const shown = box();
        if (shown) shown.focus();
        else if (foldRef.current.hidden && matchMedia("(min-width: 768px)").matches) {
          // The box is in the sidebar, which is away: it comes back, with the cursor in it.
          foldRef.current.fold(false);
          setTimeout(() => box()?.focus(), 0);
        } else {
          // In a narrow window the box is in the menu: it opens with the cursor in the box.
          wantsBox.current = true;
          setMenu(true);
        }
      } else if (key === "b" && !event.shiftKey) {
        // The sidebar, away and back. A narrow window has none to put away: it has the menu.
        if (!matchMedia("(min-width: 768px)").matches) return;
        event.preventDefault();
        foldRef.current.fold(!foldRef.current.hidden);
      } else if ((key === "o" && event.shiftKey) || (key === "n" && !event.shiftKey && desktop)) {
        event.preventDefault();
        goApp("");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const [query, setQuery] = useState("");
  /** The project being made ("new") or changed. */
  const [project, setProject] = useState<Project | "new" | null>(null);
  /** Projects whose conversations are folded away in the sidebar. */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // Closed until the person opens it: the conversation has the room.
  const [panel, setPanel] = useState(() => localStorage.getItem(PANEL_KEY) === "open");
  const view: View =
    path[0] === "approvals" ||
    path[0] === "documents" ||
    path[0] === "agents" ||
    path[0] === "knowledge" ||
    path[0] === "market" ||
    path[0] === "schedules" ||
    path[0] === "notices"
      ? path[0]
      : path[0] === "p" && path[1]
        ? "project"
        : "chat";
  const conversationId = path[0] === "c" && path[1] ? path[1] : null;
  // An address that names no page here: said, not shown as a new conversation.
  const lost = view === "chat" && path.length > 0 && !(path[0] === "c" && path[1]);

  const { data, reload } = useLoad(async () => {
    const [conversations, projects, approvals, documents, files, notices, schedules] =
      await Promise.all([
        api<ConversationSummary[]>("/api/app/conversations"),
        api<Project[]>("/api/app/projects"),
        api<Approval[]>("/api/app/approvals"),
        api<DocumentSummary[]>("/api/app/documents"),
        api<FileItem[]>("/api/app/files"),
        api<{ unread: number; notices: unknown[] }>("/api/app/notices"),
        api<unknown[]>("/api/app/schedules"),
      ]);
    return {
      conversations,
      projects,
      documents,
      files,
      unread: notices.unread,
      waiting: approvals.filter((approval) => approval.status === "pending"),
      // Whether anything has ever waited for the person or been told to them (Q-6).
      everWaited: approvals.length > 0 || notices.notices.length > 0,
      schedules: schedules.length,
    };
  });
  const refresh = useCallback(() => void reload(), [reload]);
  const here = path.join("/");
  // biome-ignore lint/correctness/useExhaustiveDependencies: moving around closes the menu and refreshes the lists
  useEffect(() => {
    setMenu(false);
    refresh();
  }, [here, refresh]);
  // An agent in another conversation may start waiting for the person at any time.
  useEffect(() => {
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const waiting = data?.waiting ?? [];
  const known = useRef<Set<string> | null>(null);
  const words = useRef<{ title: string; lead(agent: string): string }>({
    title: "",
    lead: () => "",
  });
  words.current = { title: t.app.approval.title, lead: t.app.approval.lead };
  const loaded = data !== null;
  useEffect(() => {
    if (!loaded) return;
    desktop?.setWaiting(waiting.length);
    // Tell the person about a request that appeared somewhere other than the conversation on screen.
    const before = known.current;
    known.current = new Set(waiting.map((approval) => approval.id));
    if (!before) return;
    for (const approval of waiting) {
      if (!before.has(approval.id) && approval.conversationId !== conversationId)
        notify("approvals", words.current.title, words.current.lead(approval.agentName ?? ""));
    }
  }, [loaded, waiting, conversationId]);

  /** Which view of the work pane is in front (CHA-274). */
  const [paneView, setPaneView] = useState(() => {
    const kept = localStorage.getItem(PANE_VIEW_KEY) ?? "";
    // Only a view there is: what was kept by another version is not one.
    return ["work", "running", "changes", "preview", "files"].includes(kept) ? kept : "work";
  });
  const side: Side = {
    open: panel,
    view: paneView,
    // A view's own button opens the pane on it, goes to it, or closes the pane it is on.
    show: (view) => {
      const closes = panel && paneView === view;
      localStorage.setItem(PANEL_KEY, closes ? "closed" : "open");
      localStorage.setItem(PANE_VIEW_KEY, view);
      setPanel(!closes);
      setPaneView(view);
    },
    // Where there is the one view: opened and put away, the view kept for a project left alone.
    toggle: () => {
      localStorage.setItem(PANEL_KEY, panel ? "closed" : "open");
      setPanel(!panel);
    },
    documents: data?.documents ?? [],
    files: data?.files ?? [],
    projects: data?.projects ?? [],
    schedules: data?.schedules ?? 0,
    newProject: () => setProject("new"),
    editProject: (id) => {
      const found = (data?.projects ?? []).find((item) => item.id === id);
      // Its settings are the owner's; anyone else is taken to the project's page.
      if (found?.role === "owner") setProject(found);
      else if (found) goApp(`p/${found.id}`);
    },
    manageConnections: () => setSettings("connections"),
  };

  const unread = data?.unread ?? 0;
  /**
   * The places of the workspace (CHA-262, CHA-271). Each gathers pages of one kind, which
   * are tabs above the page; every page keeps the address it had. What the person made,
   * what waits for them, what runs on its own, and what agents are and can do: the
   * company's shelf first, then the person's own agents, skills and knowledge.
   */
  const places: {
    /** The place, as the dot that marks it new is remembered by. */
    key: string;
    /** There is something in it: shown in the sidebar (Q-6). */
    has: boolean;
    to: string;
    icon: typeof BookOpenIcon;
    label: string;
    tabs: { to: string; label: string; badge?: number }[];
    badge?: number;
    /** Something waits for the person's decision: the number is in the warning colour. */
    pressing?: boolean;
  }[] = [
    {
      key: "library",
      has: (data?.files.length ?? 0) > 0 || (data?.documents.length ?? 0) > 0,
      to: "documents",
      icon: BookOpenIcon,
      label: t.app.library,
      tabs: [{ to: "documents", label: t.app.library }],
    },
    {
      key: "inbox",
      has: Boolean(data?.everWaited) || waiting.length + unread > 0,
      // One page: what waits for the person, then what happened (Inbox.tsx).
      to: "notices",
      icon: InboxIcon,
      label: t.app.inbox,
      tabs: [{ to: "notices", label: t.app.inbox }],
      badge: waiting.length + unread,
      pressing: waiting.length > 0,
    },
    {
      key: "schedules",
      // Always there, at the owner's word (2026-11-24): what runs on its own is the
      // person's to set up and to watch, and a place they cannot see is one they never
      // use. The administrators' table of everyone's schedules is for oversight only.
      has: true,
      to: "schedules",
      icon: CalendarClockIcon,
      label: t.app.schedules.title,
      tabs: [{ to: "schedules", label: t.app.schedules.title }],
    },
    {
      // One row for what agents are and can do, at the owner's word (2026-11-18): first what
      // the company offers, then the person's own agents, skills and knowledge. "Customize",
      // which held the last three in the account menu for a day, is gone.
      // Always shown: it is where agents are found.
      key: "market",
      has: true,
      to: "market",
      icon: StoreIcon,
      label: t.app.market.title,
      tabs: [
        { to: "market", label: t.app.market.title },
        { to: "agents", label: t.app.skills.agentsTab },
        { to: "agents/skills", label: t.app.skills.tab },
        { to: "knowledge", label: t.app.knowledge.tab },
      ],
    },
  ];
  /** The page in front, as a tab names it. */
  const tab =
    view === "agents" && path[1] === "skills"
      ? "agents/skills"
      : // An old address: what waited had a page of its own.
        view === "approvals"
        ? "notices"
        : view;
  const place = places.find((item) => item.tabs.some((one) => one.to === tab));
  /**
   * The sidebar grows with the person (Q-6): a place appears once there is something in
   * it, or while it is the page in front (an address still opens every page). One that
   * appears for the first time carries a dot until it is opened.
   */
  const shownPlaces = data ? places.filter((item) => item.has || item === place) : [];
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const shownKeys = shownPlaces.map((item) => item.key).join(" ");
  const loadedOnce = data !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once, when the lists have come
  useEffect(() => {
    if (loadedOnce && !seen) setSeen(seenPlaces(shownKeys.split(" ")));
  }, [loadedOnce]);
  const placeKey = place?.key;
  useEffect(() => {
    if (!placeKey || !seen || seen.has(placeKey)) return;
    markSeen(placeKey);
    setSeen(new Set([...seen, placeKey]));
  }, [placeKey, seen]);
  const mac = navigator.platform.startsWith("Mac");
  const keys = {
    fresh: desktop ? (mac ? "⌘N" : "Ctrl+N") : mac ? "⇧⌘O" : "Ctrl+Shift+O",
    find: mac ? "⌘K" : "Ctrl+K",
  };

  const needle = query.trim().toLowerCase();
  const conversations = data?.conversations ?? [];
  const matching = conversations.filter(
    (item) => !needle || `${item.title} ${item.agentName}`.toLowerCase().includes(needle),
  );
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const projects = data?.projects ?? [];
  const inProject = new Set(projects.map((item) => item.id));
  // Conversations in a project are listed under it; the rest by day, as before.
  const loose = matching.filter((item) => !item.projectId || !inProject.has(item.projectId));
  const groups: [string, ConversationSummary[]][] = [
    [t.app.today, loose.filter((item) => Date.parse(item.updatedAt) >= startOfToday)],
    [
      t.app.yesterday,
      loose.filter((item) => {
        const at = Date.parse(item.updatedAt);
        return at < startOfToday && at >= startOfToday - DAY;
      }),
    ],
    [t.app.earlier, loose.filter((item) => Date.parse(item.updatedAt) < startOfToday - DAY)],
  ];
  const conversationRow = (item: ConversationSummary, nested = false) => (
    <button
      type="button"
      key={item.id}
      onClick={() => goApp(`c/${item.id}`)}
      aria-current={conversationId === item.id ? "page" : undefined}
      title={`${item.title || t.app.untitled} · ${item.agentName}`}
      className={cn("row", nested && "pl-7")}
    >
      <span className="min-w-0 flex-1 truncate">{item.title || t.app.untitled}</span>
      {/* Who answered is not said on every row: it is nearly always the same agent. */}
      {item.running && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" />}
    </button>
  );

  const sidebar = (
    <nav className="flex h-full flex-col gap-2 p-2">
      <div className="flex h-8 items-center gap-2 px-1.5">
        <Mark className="size-6" />
        <span className="flex-1 text-sm font-semibold tracking-tight">Muster</span>
        {/* Not in a narrow window's menu, which closes by itself. */}
        <button
          type="button"
          className="hidden size-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground md:grid"
          title={t.nav.fold}
          aria-keyshortcuts="Meta+B Control+B"
          onClick={() => fold(true)}
        >
          <PanelLeftCloseIcon className="size-4" />
          <span className="sr-only">{t.nav.fold}</span>
        </button>
      </div>
      {/* What a person does most is the first row, named, with its shortcut (CHA-262). */}
      <div className="grid gap-1">
        <button
          type="button"
          onClick={() => goApp("")}
          aria-current={view === "chat" && !conversationId && !lost ? "page" : undefined}
          aria-label={t.app.newChat}
          aria-keyshortcuts={
            desktop
              ? "Meta+N Control+N Meta+Shift+O Control+Shift+O"
              : "Meta+Shift+O Control+Shift+O"
          }
          className="row"
        >
          <SquarePenIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 font-medium">{t.app.newShort}</span>
          <kbd className="font-sans text-[11px] text-muted-foreground">{keys.fresh}</kbd>
        </button>
        <label className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] focus-within:bg-foreground/5 focus-within:ring-1 focus-within:ring-ring hover:bg-foreground/5">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            data-find
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setQuery("");
              event.currentTarget.blur();
            }}
            placeholder={t.app.search}
            aria-label={t.app.search}
            aria-keyshortcuts="Meta+K Control+K"
            className="peer min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          <kbd className="font-sans text-[11px] text-muted-foreground peer-focus:hidden">
            {keys.find}
          </kbd>
        </label>
      </div>
      <div className="grid">
        {shownPlaces.map((item) => (
          <button
            type="button"
            key={item.label}
            onClick={() => goApp(item.to)}
            aria-current={place === item ? "page" : undefined}
            className="row"
          >
            <item.icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1">{item.label}</span>
            {seen && !seen.has(item.key) && !item.badge && (
              <span className="size-1.5 shrink-0 rounded-full bg-brand" title={t.app.newPlace}>
                <span className="sr-only">{t.app.newPlace}</span>
              </span>
            )}
            {!!item.badge && (
              <span
                className={cn(
                  "num rounded-full px-1.5 text-[11px] font-medium",
                  item.pressing ? "bg-warn text-white" : "bg-foreground/10 text-foreground",
                )}
              >
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {/* Said only once the list has come: before that nothing is known. */}
        {data && conversations.length === 0 && (
          <p className="px-2 text-xs text-muted-foreground">{t.app.noConversations}</p>
        )}
        {conversations.length > 0 && matching.length === 0 && (
          <p className="px-2 text-xs text-muted-foreground">{t.app.noMatches}</p>
        )}
        <div className="grid">
          <div className="flex items-center">
            <p className="section-title flex-1 pb-0.5">{t.app.projects.title}</p>
            <button
              type="button"
              className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              title={t.app.projects.create}
              onClick={() => setProject("new")}
            >
              <FolderPlusIcon className="size-3.5" />
              <span className="sr-only">{t.app.projects.create}</span>
            </button>
          </div>
          {projects.length === 0 && (
            <button
              type="button"
              className="row text-muted-foreground"
              onClick={() => setProject("new")}
            >
              <FolderPlusIcon className="size-3.5 shrink-0" />
              <span className="flex-1">{t.app.projects.first}</span>
            </button>
          )}
          {projects.map((item) => {
            const own = matching.filter((conversation) => conversation.projectId === item.id);
            // A search shows only the projects that hold a match.
            if (needle && own.length === 0 && !item.name.toLowerCase().includes(needle))
              return null;
            const open = !folded.has(item.id) || Boolean(needle);
            return (
              <div key={item.id} className="group/project grid">
                <div className="flex items-center">
                  {/* The arrow folds its conversations away; the name opens the project's page. */}
                  <button
                    type="button"
                    className="ml-1 grid size-5 shrink-0 place-items-center rounded hover:bg-foreground/8"
                    aria-expanded={open}
                    aria-label={t.app.project.fold(item.name)}
                    onClick={() =>
                      setFolded((now) => {
                        const next = new Set(now);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-90",
                      )}
                    />
                  </button>
                  <button
                    type="button"
                    className="row min-w-0 flex-1 pl-1"
                    aria-current={view === "project" && path[1] === item.id ? "page" : undefined}
                    onClick={() => goApp(`p/${item.id}`)}
                  >
                    {/* One with other people in it, the person's own or a colleague's, shows so. */}
                    {item.owner || item.people > 0 ? (
                      <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className="min-w-0 flex-1 truncate font-medium"
                      title={
                        item.owner
                          ? t.app.project.theirs(item.owner.name, worksIn(item))
                          : undefined
                      }
                    >
                      {item.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    hidden={item.role !== "owner"}
                    className="rounded p-1 text-muted-foreground opacity-0 hover:bg-foreground/8 hover:text-foreground group-hover/project:opacity-100 focus-visible:opacity-100"
                    title={t.app.projects.edit}
                    onClick={() => setProject(item)}
                  >
                    <PencilIcon className="size-3" />
                    <span className="sr-only">{t.app.projects.edit}</span>
                  </button>
                  <button
                    type="button"
                    hidden={!worksIn(item)}
                    className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:bg-foreground/8 hover:text-foreground group-hover/project:opacity-100 focus-visible:opacity-100"
                    title={t.app.projects.newIn(item.name)}
                    onClick={() => {
                      preferProject(item.id);
                      // The start page shows the choice the next time it is drawn.
                      goApp("");
                      refresh();
                    }}
                  >
                    <SquarePenIcon className="size-3" />
                    <span className="sr-only">{t.app.projects.newIn(item.name)}</span>
                  </button>
                </div>
                {open && own.map((conversation) => conversationRow(conversation, true))}
                {open && own.length === 0 && (
                  <p className="py-0.5 pl-7 text-xs text-muted-foreground">
                    {t.app.projects.empty}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {groups.map(
          ([title, items]) =>
            items.length > 0 && (
              <div key={title} className="grid">
                <p className="section-title pb-0.5">{title}</p>
                {items.map((item) => conversationRow(item))}
              </div>
            ),
        )}
      </div>
      <div className="grid border-t pt-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="row">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-brand text-[11px] font-medium text-white">
                {(me.user.name || me.user.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">{me.user.name || me.user.email}</span>
              <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                {me.org.name}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {address(me.user.email) && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{me.user.email}</div>
            )}
            <DropdownMenuItem onSelect={() => setSettings("account")}>
              <SettingsIcon />
              <span className="flex-1">{t.prefs.title}</span>
              <kbd className="font-sans text-xs text-muted-foreground">
                {navigator.platform.startsWith("Mac") ? "⌘," : "Ctrl+,"}
              </kbd>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSettings("usage")}>
              <BarChart3Icon />
              {t.prefs.sections.usage}
            </DropdownMenuItem>
            {me.permissions.includes("console.access") && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => location.assign("#/admin")}>
                  <ShieldCheckIcon />
                  {t.app.admin}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <LogOutIcon />
              {t.settings.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );

  const bar: Bar = {
    // Without the sidebar, in a narrow window or with it put away: the way back to it,
    // and a new conversation beside it.
    lead: (
      <div className={cn("flex shrink-0 items-center", !hidden && "md:hidden")}>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 md:hidden"
          onClick={() => setMenu(true)}
          aria-label={t.nav.open}
        >
          <MenuIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-7 md:inline-flex"
          onClick={() => fold(false)}
          aria-label={t.nav.unfold}
          title={t.nav.unfold}
          aria-keyshortcuts="Meta+B Control+B"
        >
          <PanelLeftIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => goApp("")}
          aria-label={t.app.newChat}
          title={t.app.newChat}
        >
          <SquarePenIcon className="size-4" />
        </Button>
      </div>
    ),
    trail: (
      <div className="flex shrink-0 items-center">
        {/* In the desktop app each view of the pane has a button of its own in the conversation's bar. */}
        {conversationId && !desktop && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("hidden size-7 lg:inline-flex", panel && "bg-accent")}
            aria-pressed={panel}
            title={t.app.panel.toggle}
            onClick={() => {
              localStorage.setItem(PANEL_KEY, panel ? "closed" : "open");
              setPanel(!panel);
            }}
          >
            <PanelRightIcon className="size-4" />
            <span className="sr-only">{t.app.panel.toggle}</span>
          </Button>
        )}
      </div>
    ),
  };

  return (
    <OpenFileProvider value={setViewing}>
      {/* The workspace is the window: it never scrolls as a whole, only the lists inside it do. */}
      <div
        className="stage fixed inset-0 flex gap-2 overflow-clip p-0 text-[13px] md:p-2"
        data-folded={hidden || undefined}
      >
        <aside
          className={cn("app-lights glass hidden w-60 shrink-0 rounded-xl", !hidden && "md:block")}
        >
          {sidebar}
        </aside>
        <Sheet open={menu} onOpenChange={setMenu}>
          <SheetContent
            side="left"
            className="app-lights glass-thick p-0"
            onOpenAutoFocus={(event) => {
              if (!wantsBox.current) return;
              wantsBox.current = false;
              event.preventDefault();
              (event.currentTarget as HTMLElement)
                .querySelector<HTMLInputElement>("input[data-find]")
                ?.focus();
            }}
          >
            <SheetTitle className="sr-only">{t.nav.open}</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>
        {lost ? (
          <div className="glass-strong grid min-w-0 flex-1 place-items-center rounded-xl p-6">
            <div className="grid max-w-sm justify-items-center gap-2 text-center">
              <p className="text-sm font-medium">{t.app.lost.title}</p>
              <Lead className="text-[13px] text-muted-foreground">{t.app.lost.lead}</Lead>
              <Button size="sm" onClick={() => goApp("")}>
                {t.app.lost.home}
              </Button>
            </div>
          </div>
        ) : view === "project" ? (
          (() => {
            const shown = data?.projects.find((one) => one.id === path[1]);
            return shown ? (
              <ProjectPage
                key={shown.id}
                project={shown}
                conversations={(data?.conversations ?? []).filter(
                  (one) => one.projectId === shown.id,
                )}
                waiting={data?.waiting ?? []}
                bar={bar}
                onChange={refresh}
                onSettings={() => setProject(shown)}
              />
            ) : (
              // Not there, or not yet loaded: the bar keeps the way back.
              <div className="glass-strong flex min-w-0 flex-1 flex-col rounded-xl">
                <PaneBar bar={bar}>{null}</PaneBar>
                {data && <p className="p-6 text-muted-foreground">{t.app.project.gone}</p>}
              </div>
            );
          })()
        ) : view === "chat" ? (
          <Chat id={conversationId} me={me} onChange={refresh} side={side} bar={bar} />
        ) : (
          <div className="glass-strong flex min-w-0 flex-1 flex-col rounded-xl">
            <PaneBar bar={bar}>
              {place && place.tabs.length > 1 ? (
                // The pages of one place are kept together, each a tab.
                <div className="flex rounded-lg bg-foreground/6 p-0.5">
                  {place.tabs.map((one) => (
                    <button
                      type="button"
                      key={one.to}
                      aria-pressed={tab === one.to}
                      onClick={() => goApp(one.to)}
                      className={cn(
                        "flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px]",
                        tab === one.to
                          ? "bg-background font-medium shadow-xs"
                          : "text-muted-foreground",
                      )}
                    >
                      {one.label}
                      {!!one.badge && (
                        <span className="num text-[11px] text-muted-foreground">{one.badge}</span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="font-medium">{place?.label}</span>
              )}
            </PaneBar>
            {view === "approvals" || view === "notices" ? (
              <Inbox onChange={refresh} />
            ) : view === "documents" ? (
              <MyDocuments open={titleIn(path[1])} projects={side.projects} onChange={refresh} />
            ) : view === "knowledge" ? (
              <MyKnowledge />
            ) : view === "market" ? (
              <Marketplace />
            ) : view === "schedules" ? (
              <MySchedules />
            ) : path[1] === "skills" ? (
              <MySkills />
            ) : (
              <MyAgents />
            )}
          </div>
        )}
        {settings && (
          <Settings
            me={me}
            section={settings}
            onSection={setSettings}
            onClose={() => setSettings(null)}
            onChange={refresh}
          />
        )}
        {project && (
          <ProjectDialog
            project={project === "new" ? null : project}
            onClose={(saved) => {
              setProject(null);
              if (!saved) return;
              // A project just made is where the next conversation starts; one deleted is forgotten.
              if (saved === "deleted") {
                if (project !== "new" && preferredProject() === project.id) preferProject(null);
              } else if (project === "new") preferProject(saved);
              refresh();
            }}
          />
        )}
        {viewing && (
          <FileViewer file={viewing} onClose={() => setViewing(null)} onDeleted={refresh} />
        )}
      </div>
    </OpenFileProvider>
  );
}
