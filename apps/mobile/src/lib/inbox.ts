/** Something the person is told: who shared what, what finished, what stopped. */
export interface InboxNotice {
  id: string;
  kind: string;
  detail: Record<string, string | null>;
  /** Where it leads in the web app: "c/<conversation>", "p/<project>", "schedules", … */
  link: string;
  createdAt: string;
  readAt: string | null;
}

/**
 * The same thing told several times in a row (a schedule that finished every morning this
 * week) is one line with how often, under the latest of them. Something else in between
 * ends the run: the order things happened in is kept. The same reading as the web app's
 * (`apps/web/src/app/inboxRuns.ts`).
 */
export function runsOf(notices: readonly InboxNotice[]): { notice: InboxNotice; times: number }[] {
  const same = (a: InboxNotice, b: InboxNotice) =>
    a.kind === b.kind && a.link === b.link && JSON.stringify(a.detail) === JSON.stringify(b.detail);
  const runs: { notice: InboxNotice; times: number }[] = [];
  for (const notice of notices) {
    const last = runs.at(-1);
    if (last && same(last.notice, notice)) {
      last.times += 1;
      // One unread among them marks the line.
      if (!notice.readAt) last.notice = { ...last.notice, readAt: null };
    } else runs.push({ notice, times: 1 });
  }
  return runs;
}

/**
 * What a notice opens on the phone: a conversation or a project. The rest of what the web
 * app links to (schedules, the marketplace, the admin console) has no screen here, so the
 * line says what happened and opens nothing.
 */
export function opens(
  link: string,
): { screen: "conversation"; id: string } | { screen: "project"; id: string } | null {
  const [place, id] = link.replace(/^#?\/?/, "").split("/");
  if (!id || !/^[0-9a-f-]{8,}$/i.test(id)) return null;
  if (place === "c") return { screen: "conversation", id };
  if (place === "p") return { screen: "project", id };
  return null;
}
