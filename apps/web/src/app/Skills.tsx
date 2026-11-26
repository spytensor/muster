import {
  FileTextIcon,
  PlusIcon,
  ScrollTextIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
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
import { Input, Label, Textarea } from "@/components/ui/input";
import { Guide } from "@/components/guide";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ShareDialog } from "./Share";
import { Lead } from "@/components/ui/hint";

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  texts: { name: string; text: string }[];
  mine: boolean;
  sharedBy: { name: string; email: string } | null;
  shares: number;
  scanStatus: "passed" | "failed";
  scanFindings: { rule: string; excerpt: string }[];
}
const TEXT_LIMIT = 40_000;

/** Whether a skill may go to others, said in a few words and a colour. */
function ScanBadge({ skill }: { skill: Pick<Skill, "scanStatus" | "scanFindings"> }) {
  const { t } = useI18n();
  const k = t.app.skills;
  const ok = skill.scanStatus === "passed";
  const Icon = ok ? ShieldCheckIcon : ShieldAlertIcon;
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
        ok ? "bg-ok/12 text-ok" : "bg-warn/14 text-warn",
      )}
    >
      <Icon className="size-3" />
      {ok ? k.passed : k.failed(skill.scanFindings.length)}
    </span>
  );
}

function SkillTile({ skill, onOpen }: { skill: Skill; onOpen(): void }) {
  const { t } = useI18n();
  const k = t.app.skills;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="glass-thick flex flex-col gap-2 rounded-2xl p-4 text-left transition-colors hover:bg-accent/40"
    >
      <span className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/12 text-brand-text">
          <ScrollTextIcon className="size-4" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{skill.name}</span>
            <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
              {skill.mine
                ? t.app.builder.byYou
                : t.app.builder.sharedBy(skill.sharedBy?.name || skill.sharedBy?.email || "")}
            </span>
          </span>
          <span className="line-clamp-2 text-[13px] text-muted-foreground">
            {skill.description || k.noDescription}
          </span>
        </span>
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
        {skill.mine && <ScanBadge skill={skill} />}
        {skill.texts.length > 0 && (
          <span className="flex items-center gap-1 rounded-full border px-2 py-0.5">
            <FileTextIcon className="size-3" />
            {k.textsCount(skill.texts.length)}
          </span>
        )}
        {skill.mine && skill.shares > 0 && (
          <span className="flex items-center gap-1 rounded-full border px-2 py-0.5">
            <UsersIcon className="size-3" />
            {t.app.builder.sharedWith(skill.shares)}
          </span>
        )}
      </span>
    </button>
  );
}

/** Writing a skill, or reading one a colleague shared. Saving scans it and says what was found. */
function SkillEditor({
  skill,
  onClose,
  onShare,
}: {
  skill: Skill | null;
  onClose(changed: boolean): void;
  onShare(skill: Skill): void;
}) {
  const { t } = useI18n();
  const k = t.app.skills;
  const readOnly = skill !== null && !skill.mine;
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [texts, setTexts] = useState(skill?.texts ?? []);
  const [scan, setScan] = useState(
    skill ? { scanStatus: skill.scanStatus, scanFindings: skill.scanFindings } : null,
  );
  const [saved, setSaved] = useState(false);
  // A new skill is created by its first save. A second save, after correcting what the scan
  // found, changes that one: it does not try to create it again.
  const [id, setId] = useState(skill?.id ?? null);
  const { error, busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const pick = useRef<HTMLInputElement>(null);
  const ready = name.trim() && instructions.trim();
  const body = { name, description, instructions, texts };
  const save = () =>
    run(async () => {
      const result = await api<{
        id: string;
        scanStatus: Skill["scanStatus"];
        scanFindings: Skill["scanFindings"];
      }>(id ? `/api/app/skills/${id}` : "/api/app/skills", {
        method: id ? "PATCH" : "POST",
        body,
      });
      setId(result.id);
      setScan(result);
      setSaved(true);
      // Passed: nothing more to say. Not passed: stay, so what was found can be read and changed.
      if (result.scanStatus === "passed") onClose(true);
    });
  const remove = async () => {
    if (!skill || !(await confirm(t.common.delete, k.deleteConfirm(skill.name)))) return;
    await run(async () => {
      await api(`/api/app/skills/${skill.id}`, { method: "DELETE" });
      onClose(true);
    });
  };
  const addFile = async (file: File | undefined) => {
    if (!file) return;
    const text = (await file.text()).slice(0, TEXT_LIMIT);
    setTexts((now) => [...now, { name: file.name.slice(0, 120), text }].slice(0, 5));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(saved)}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{readOnly ? skill.name : id ? k.edit : k.new}</DialogTitle>
          <DialogDescription>{readOnly ? k.readOnly : k.lead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {!readOnly && (
            <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
              <Label className="grid gap-1.5">
                {k.name}
                <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              </Label>
              <Label className="grid gap-1.5">
                {k.when}
                <Input
                  value={description}
                  maxLength={300}
                  placeholder={k.whenHint}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Label>
            </div>
          )}
          {readOnly && skill.description && <p className="text-sm">{skill.description}</p>}
          <Label className="grid gap-1.5">
            {k.instructions}
            <Textarea
              className="min-h-48 font-mono text-[13px]"
              value={instructions}
              readOnly={readOnly}
              maxLength={12_000}
              placeholder={k.instructionsHint}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </Label>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">{k.texts}</span>
            {texts.length === 0 && (
              <Lead className="text-xs text-muted-foreground">{k.textsHint}</Lead>
            )}
            {texts.map((item, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: texts are added and removed at the end
                key={index}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
              >
                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="num shrink-0 text-xs text-muted-foreground">
                  {k.characters(item.text.length)}
                </span>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={t.common.remove}
                    onClick={() => setTexts((now) => now.filter((_, i) => i !== index))}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {!readOnly && texts.length < 5 && (
              <div>
                <input
                  ref={pick}
                  type="file"
                  accept=".txt,.md,.csv,.json,text/*"
                  className="hidden"
                  onChange={(event) => {
                    void addFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => pick.current?.click()}>
                  <PlusIcon />
                  {k.addText}
                </Button>
              </div>
            )}
          </div>
          {scan && !readOnly && scan.scanStatus === "failed" && (
            <Notice tone="info" title={k.foundTitle}>
              <p>{k.foundLead}</p>
              <ul className="mt-1.5 grid gap-1">
                {scan.scanFindings.map((finding, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list from one scan
                  <li key={index} className="text-[13px]">
                    <span className="font-medium">{k.rules[finding.rule] ?? finding.rule}</span>
                    <span className="block font-mono text-xs break-words text-muted-foreground">
                      …{finding.excerpt}…
                    </span>
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          {skill?.mine && (
            <span className="flex items-center gap-2 sm:mr-auto">
              <MoreMenu
                label={t.common.more}
                items={[
                  { label: t.common.delete, destructive: true, onSelect: () => void remove() },
                ]}
              />
              {scan?.scanStatus === "passed" && (
                <Button variant="outline" onClick={() => onShare(skill)}>
                  <UsersIcon />
                  {skill.shares ? t.app.builder.sharedWith(skill.shares) : t.app.builder.share}
                </Button>
              )}
            </span>
          )}
          <Button variant="outline" onClick={() => onClose(saved)}>
            {readOnly ? t.common.close : t.common.cancel}
          </Button>
          {!readOnly && (
            <Button disabled={!ready || busy} onClick={() => void save()}>
              {t.common.save}
            </Button>
          )}
        </DialogFooter>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}

/** A person's skills: the ways of working they wrote down, and the ones colleagues shared. */
export function MySkills() {
  const { t } = useI18n();
  const k = t.app.skills;
  const { data, error, reload } = useLoad(() => api<Skill[]>("/api/app/skills"));
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [sharing, setSharing] = useState<Skill | null>(null);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const needle = query.trim().toLowerCase();
  const shown = data.filter(
    (skill) => !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle),
  );
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={k.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Lead as="span" className="text-xs text-muted-foreground">
            {k.how}
          </Lead>
          <Button size="sm" className="ml-auto" onClick={() => setEditing("new")}>
            <PlusIcon />
            {k.new}
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((skill) => (
            <SkillTile key={skill.id} skill={skill} onOpen={() => setEditing(skill)} />
          ))}
          {!needle && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-2xl border border-dashed p-4 text-center text-muted-foreground hover:bg-accent/40"
            >
              <PlusIcon className="size-5" />
              <span className="text-sm font-medium text-foreground">{k.first}</span>
              <span className="max-w-64 text-xs">{k.firstHint}</span>
            </button>
          )}
        </div>
        {shown.length === 0 && needle && <Notice>{k.noMatch}</Notice>}
        {data.length === 0 && <Guide icon={ScrollTextIcon} text={t.app.guides.skills} />}
      </div>
      {editing && (
        <SkillEditor
          skill={editing === "new" ? null : editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
          onShare={(skill) => {
            setEditing(null);
            setSharing(skill);
          }}
        />
      )}
      {sharing && (
        <ShareDialog
          kind="skill"
          id={sharing.id}
          name={sharing.name}
          onClose={(changed) => {
            setSharing(null);
            if (changed) void reload();
          }}
        />
      )}
    </div>
  );
}
