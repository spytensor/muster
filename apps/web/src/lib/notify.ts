import { desktop } from "./desktop";

/** What the person can be told about while Muster is in the background. Each can be turned off in Settings. */
export type NoticeKind = "approvals" | "replies";

const key = (kind: NoticeKind) => `muster.notify.${kind}`;
export const wantsNotice = (kind: NoticeKind) => localStorage.getItem(key(kind)) !== "off";
export const setWantsNotice = (kind: NoticeKind, on: boolean) =>
  localStorage.setItem(key(kind), on ? "on" : "off");

/** Whether this browser will show notifications: "granted", "denied", "default" (not asked yet) or "unsupported". The desktop app always can. */
export const noticePermission = (): NotificationPermission | "unsupported" =>
  desktop ? "granted" : "Notification" in window ? Notification.permission : "unsupported";
export const askNoticePermission = async () =>
  desktop || !("Notification" in window) ? noticePermission() : Notification.requestPermission();

/** Tells the person something happened, if they asked to be told and are not looking at Muster. */
export function notify(kind: NoticeKind, title: string, body: string): void {
  if (!wantsNotice(kind)) return;
  // The desktop app decides for itself whether its window is in front.
  if (desktop) desktop.notify(title, body);
  else if (document.hidden && noticePermission() === "granted") new Notification(title, { body });
}
