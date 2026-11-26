import { useState } from "react";
import { Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api, type ErasePreview } from "@/lib/api";

const KINDS = [
  "conversations",
  "files",
  "documents",
  "projects",
  "memories",
  "traces",
  "schedules",
] as const;

/**
 * Asks before everything of a removed member is taken away for good: says what there is,
 * what stays, and has the person's address typed out.
 * See docs/features/admin-console.md, "Retention and erasure".
 */
export function EraseMemberDialog({ id, onClose }: { id: string; onClose(erased: boolean): void }) {
  const { t, number } = useI18n();
  const e = t.members.erase;
  const preview = useLoad(() => api<ErasePreview>(`/api/members/${id}/erase`), [id]);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState(false);
  const action = useAction();
  const data = preview.data;
  const there = data ? KINDS.filter((kind) => (data.holds[kind] ?? 0) > 0) : [];
  /** The names there are, and how many more there are than names. */
  const named = (of: { count: number; names: string[] }) =>
    of.names.join(", ") +
    (of.count > of.names.length ? e.more(number(of.count - of.names.length)) : "");
  const matches = data ? typed.trim().toLowerCase() === data.email.toLowerCase() : false;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(done)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{e.title}</DialogTitle>
          <DialogDescription>{data ? e.lead(data.email) : ""}</DialogDescription>
        </DialogHeader>
        {preview.error ? (
          <Notice tone="bad">{preview.error}</Notice>
        ) : !data ? (
          <Loading />
        ) : done ? (
          <Notice tone="ok">{e.done(data.email)}</Notice>
        ) : (
          <div className="grid gap-3">
            {data.hold && <Notice tone="bad">{e.held}</Notice>}
            <div className="grid gap-1.5 text-sm">
              <p className="font-medium">{e.goes}</p>
              {there.length === 0 ? (
                <p className="text-muted-foreground">{e.nothing}</p>
              ) : (
                <ul className="grid gap-0.5 text-muted-foreground">
                  {there.map((kind) => (
                    <li key={kind}>{e.kinds[kind]?.(number(data.holds[kind] ?? 0))}</li>
                  ))}
                </ul>
              )}
              <p className="text-muted-foreground">{e.goesToo}</p>
            </div>
            {data.handed.projects.count + data.handed.files.count > 0 && (
              <div className="grid gap-1.5 text-sm">
                <p className="font-medium">{e.handed}</p>
                <ul className="grid gap-0.5 text-muted-foreground">
                  {data.handed.projects.count > 0 && (
                    <li>
                      {e.handedProjects(
                        number(data.handed.projects.count),
                        named(data.handed.projects),
                      )}
                    </li>
                  )}
                  {data.handed.files.count > 0 && (
                    <li>
                      {e.handedFiles(number(data.handed.files.count), named(data.handed.files))}
                    </li>
                  )}
                </ul>
                <p className="text-muted-foreground">{e.handedWhy}</p>
              </div>
            )}
            <div className="grid gap-1.5 text-sm">
              <p className="font-medium">{e.stays}</p>
              <p className="text-muted-foreground">{e.staysWhat}</p>
            </div>
            <Notice tone="bad">{e.forGood}</Notice>
            <Label className="grid gap-1.5">
              {e.type(data.email)}
              <Input
                value={typed}
                autoComplete="off"
                disabled={data.hold}
                onChange={(event) => setTyped(event.target.value)}
              />
            </Label>
            {action.error && <Notice tone="bad">{action.error}</Notice>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(done)}>
            {done ? t.common.close : t.common.cancel}
          </Button>
          {data && !done && (
            <Button
              variant="destructive"
              disabled={!matches || data.hold || action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(`/api/members/${id}/erase`, {
                    method: "POST",
                    body: JSON.stringify({ email: typed.trim() }),
                  });
                  setDone(true);
                })
              }
            >
              {action.busy ? e.erasing : e.confirm}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
