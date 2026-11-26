import { describe, expect, it } from "vitest";
import { type InboxNotice, runsOf } from "./inboxRuns";

const notice = (
  id: string,
  kind: string,
  title: string,
  readAt: string | null = "x",
): InboxNotice => ({
  id,
  kind,
  detail: { title },
  link: "schedules",
  createdAt: `2026-11-2${id}T05:00:00Z`,
  readAt,
});

describe("the inbox", () => {
  it("says the same thing once, with how often, and keeps the order things happened in", () => {
    const runs = runsOf([
      notice("4", "schedule_done", "Weekly report"),
      notice("3", "schedule_done", "Weekly report", null),
      notice("2", "schedule_failed", "Weekly report"),
      notice("1", "schedule_done", "Weekly report"),
      notice("0", "schedule_done", "Something else"),
    ]);
    expect(runs.map((run) => [run.notice.id, run.times])).toEqual([
      ["4", 2],
      ["2", 1],
      ["1", 1],
      ["0", 1],
    ]);
    // One unread among them marks the line.
    expect(runs[0]?.notice.readAt).toBeNull();
    expect(runsOf([])).toEqual([]);
  });
});
