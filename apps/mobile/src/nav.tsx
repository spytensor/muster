import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { createContext, useContext } from "react";

/**
 * The screens, and what each needs to open (CHA-260). There are no tabs: `Home` is the
 * conversation, with a drawer beside it (CHA-261); Agents, Documents, the Inbox and Settings
 * open from the drawer as a sheet, and what they open is pushed inside that sheet.
 */
export type RootParams = {
  /**
   * The conversation in front. With `id`, that one; with `agentId` or `fresh`, the start of
   * a new one; with nothing, the latest conversation, or the start of the first.
   */
  Home: { id?: string; agentId?: string; fresh?: number } | undefined;
  /** The sheet over the conversation: a stack of its own, opened on one of these screens. */
  Sheet: { screen: "Agents" | "Documents" | "Inbox" | "Settings" };
  Agents: undefined;
  Documents: undefined;
  /** What waits for the person, then what happened (2026-11-24: one list, as on the web). */
  Inbox: undefined;
  /** A project, to look at: its steps, its latest update, its key documents. */
  Project: { id: string };
  Settings: undefined;
  /** One setting on a page of its own: something typed, or read at length. */
  Setting: { part: "hours" | "style" | "signature" | "usage" };
  Document: { id?: string } | undefined;
  Agent: { id?: string } | undefined;
  /** A file shown as its text: web pages, which are never run. */
  FileText: { id: string; name: string };
};

export const useNav = () => useNavigation<NativeStackNavigationProp<RootParams>>();

/** How many things wait for the person (approvals to decide, and what they have not read), and how to recount. */
export const Waiting = createContext<{ count: number; refresh(): void }>({
  count: 0,
  refresh: () => undefined,
});
export const useWaiting = () => useContext(Waiting);
