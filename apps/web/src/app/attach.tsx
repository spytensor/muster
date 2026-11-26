import { PaperclipIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { ApiError } from "@/lib/api";
import { uploadFile } from "@/lib/files";
import type { FileItem } from "./api";
import { FileChip } from "./FileViewer";

interface Pending {
  key: string;
  name: string;
  /** The stored file, once the upload has finished. */
  file?: FileItem;
  /** Why it could not be uploaded. */
  problem?: string;
}

/** The files a person is about to send with a message: each uploads as soon as it is chosen. */
export function useAttachments() {
  const { t, errorText } = useI18n();
  const [items, setItems] = useState<Pending[]>([]);
  const words = useRef({ t, errorText });
  words.current = { t, errorText };
  const add = useCallback((list: Iterable<File>) => {
    for (const file of list) {
      const key = crypto.randomUUID();
      setItems((now) => [...now, { key, name: file.name }]);
      const settle = (change: Partial<Pending>) =>
        setItems((now) => now.map((item) => (item.key === key ? { ...item, ...change } : item)));
      uploadFile(file).then(
        (stored) => settle({ file: stored }),
        (failure) => {
          const { t, errorText } = words.current;
          const code = failure instanceof ApiError ? failure.code : "";
          settle({
            // Which file, and what was wrong with it: two files that fail are two lines
            // that say different things, not the same sentence twice.
            problem:
              code === "unsupported_file"
                ? t.files.notAccepted(file.name)
                : code === "file_not_readable"
                  ? t.files.unreadable(file.name)
                  : code === "network"
                    ? t.files.notSent(file.name)
                    : `${file.name}: ${errorText(failure)}`,
          });
        },
      );
    }
  }, []);
  const remove = useCallback(
    (key: string) => setItems((now) => now.filter((item) => item.key !== key)),
    [],
  );
  const clear = useCallback(() => setItems([]), []);
  /** Puts back files that were already uploaded, when the message they went with was refused. */
  const restore = useCallback(
    (files: FileItem[]) =>
      setItems((now) => [
        ...files.map((file) => ({ key: file.id, name: file.name, file })),
        ...now.filter((item) => !files.some((file) => file.id === item.key)),
      ]),
    [],
  );
  return {
    items,
    add,
    remove,
    clear,
    restore,
    /** Files that are uploaded and will go with the message. */
    ready: items.flatMap((item) => (item.file ? [item.file] : [])),
    /** Whether something is still uploading. */
    busy: items.some((item) => !item.file && !item.problem),
  };
}
export type Attachments = ReturnType<typeof useAttachments>;

/** What is about to be sent along: uploaded files as chips, uploads in progress, and anything refused with its reason. */
export function AttachmentTray({ attach }: { attach: Attachments }) {
  const { t } = useI18n();
  if (attach.items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1 pr-1 pb-1.5">
      {attach.items.map((item) =>
        item.file ? (
          <FileChip key={item.key} file={item.file} onRemove={() => attach.remove(item.key)} />
        ) : (
          <span
            key={item.key}
            className={
              item.problem
                ? "inline-flex min-h-7 items-center gap-1.5 rounded-md border border-destructive/40 px-2 text-xs text-destructive"
                : "inline-flex h-7 animate-pulse items-center rounded-md border px-2 text-xs text-muted-foreground"
            }
          >
            {item.problem ?? t.files.uploading(item.name)}
            {item.problem && (
              <button
                type="button"
                aria-label={t.files.remove(item.name)}
                onClick={() => attach.remove(item.key)}
              >
                ×
              </button>
            )}
          </span>
        ),
      )}
    </div>
  );
}

/** The paperclip: opens the system's file chooser. */
export function AttachButton({ attach, disabled }: { attach: Attachments; disabled?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) attach.add(event.target.files);
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0 rounded-full"
        disabled={disabled}
        title={t.files.attach}
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon className="size-4" />
        <span className="sr-only">{t.files.attach}</span>
      </Button>
    </>
  );
}
