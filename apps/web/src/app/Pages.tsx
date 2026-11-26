import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { Markdown } from "./markdown";
import { Lead } from "@/components/ui/hint";

/** A page of the workspace under its top bar: one line saying what it is, an action, then the content. */
function _Page({
  lead,
  action,
  children,
}: {
  lead: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-3 px-4 py-3">
        <div className="flex min-h-8 flex-wrap items-center gap-3">
          <Lead className="min-w-0 flex-1 text-[13px] text-muted-foreground">{lead}</Lead>
          {action}
        </div>
        {children}
      </div>
    </div>
  );
}

export const approvalVariant = {
  pending: "warn",
  approved: "ok",
  rejected: "destructive",
  expired: "muted",
} as const;

export interface Doc {
  id: string | null;
  title: string;
  content: string;
  /** When an agent replaced what this document held; that earlier content can be brought back. */
  previousAt?: string | null;
  updatedAt?: string | null;
}

export function DocumentEditor({ doc, onClose }: { doc: Doc; onClose(changed: boolean): void }) {
  const { t, ago } = useI18n();
  const d = t.app.docs;
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);
  // A document that has words in it opens to be read; a new or empty one opens to be written.
  const [editing, setEditing] = useState(!doc.id || !doc.content.trim());
  const { busy, error, run } = useAction();
  const save = () =>
    run(async () => {
      await api(doc.id ? `/api/app/documents/${doc.id}` : "/api/app/documents", {
        method: doc.id ? "PUT" : "POST",
        body: { title: title.trim(), content },
      });
      onClose(true);
    });
  const restore = () =>
    run(async () => {
      await api(`/api/app/documents/${doc.id}/restore`, { method: "POST" });
      onClose(true);
    });
  const { confirm, dialog } = useConfirm();
  const remove = async () => {
    if (!doc.id || !(await confirm(t.common.delete, d.deleteConfirm(doc.title)))) return;
    await run(async () => {
      await api(`/api/app/documents/${doc.id}`, { method: "DELETE" });
      onClose(true);
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{doc.id ? doc.title : d.new}</DialogTitle>
          <DialogDescription>
            {editing
              ? d.writeHint
              : [doc.updatedAt && d.changed(ago(doc.updatedAt)), d.size(doc.content.length)]
                  .filter(Boolean)
                  .join(" · ")}
          </DialogDescription>
        </DialogHeader>
        {doc.id && doc.previousAt && (
          <Notice>
            <span className="flex flex-wrap items-center justify-between gap-2">
              {d.replaced(ago(doc.previousAt))}
              <Button
                size="sm"
                variant="outline"
                // Bringing it back replaces what is in the box, so it waits until nothing unsaved is there.
                disabled={busy || content !== doc.content || title !== doc.title}
                onClick={() => void restore()}
              >
                {d.bringBack}
              </Button>
            </span>
          </Notice>
        )}
        {editing ? (
          <>
            <Label>
              {d.titleLabel}
              <Input
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Label>
            <Label>
              {d.body}
              <Textarea
                value={content}
                rows={16}
                className="font-mono text-[13px]"
                onChange={(event) => setContent(event.target.value)}
              />
            </Label>
          </>
        ) : (
          <div className="max-h-[60vh] min-w-0 overflow-y-auto pr-1">
            <Markdown text={doc.content} />
          </div>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        <DialogFooter>
          {doc.id && (
            <span className="sm:mr-auto">
              <MoreMenu
                label={t.common.more}
                items={[
                  { label: t.common.delete, destructive: true, onSelect: () => void remove() },
                ]}
              />
            </span>
          )}
          {editing ? (
            <>
              <Button
                variant="outline"
                // Cancelling the writing of a document that was being read goes back to reading it.
                onClick={() => {
                  if (!doc.id || !doc.content.trim()) return onClose(false);
                  setTitle(doc.title);
                  setContent(doc.content);
                  setEditing(false);
                }}
              >
                {t.common.cancel}
              </Button>
              <Button disabled={busy || !title.trim()} onClick={() => void save()}>
                {t.common.save}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onClose(false)}>
                {t.common.close}
              </Button>
              <Button onClick={() => setEditing(true)}>
                <PencilIcon />
                {d.edit}
              </Button>
            </>
          )}
        </DialogFooter>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}
