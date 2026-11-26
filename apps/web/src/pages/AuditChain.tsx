import { DownloadIcon, SendIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { Dot, Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { type AuditChain, type AuditForward, api, type ChainBroken } from "@/lib/api";
import { Lead } from "@/components/ui/hint";

/**
 * Whether the record still proves itself, and where it is sent on to. Above the record
 * on the activity log page. See docs/features/admin-console.md.
 */
export function AuditChainCard({
  canManage,
  from,
  to,
}: {
  canManage: boolean;
  from: string;
  to: string;
}) {
  const { t, ago, number, dateTime } = useI18n();
  const k = t.audit.chain;
  const chain = useLoad(() => api<AuditChain>("/api/audit/chain"));
  const check = useAction();
  const [editing, setEditing] = useState(false);
  if (chain.error) return <Notice tone="bad">{chain.error}</Notice>;
  const data = chain.data;
  if (!data) return null;
  const broken: ChainBroken | null =
    data.checkedOk === false ? (data.checked?.broken ?? null) : null;
  const range = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {k.title}
          {data.checkedOk === null ? (
            <Badge variant="muted">{k.unchecked}</Badge>
          ) : data.checkedOk ? (
            <Badge variant="ok">
              <Dot />
              {k.ok}
            </Badge>
          ) : (
            <Badge variant="destructive">
              <Dot />
              {k.bad}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {k.lead} {k.limit}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm text-muted-foreground">
            {k.records(number(data.records))}
            {" · "}
            {data.checkedAt ? k.checked(ago(data.checkedAt)) : k.neverChecked}
            {data.checked && data.checked.purged > 0 && (
              <>
                {" · "}
                {k.purged(number(data.checked.purged))}
              </>
            )}
          </p>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={check.busy}
              onClick={() =>
                void check.run(async () => {
                  await api("/api/audit/chain/verify", { method: "POST" });
                  await chain.reload();
                })
              }
            >
              <ShieldCheckIcon />
              {check.busy ? k.checking : k.check}
            </Button>
            <Button variant="outline" size="sm" asChild title={k.exportHint}>
              <a href={`/api/audit/chain/export?${range.toString()}`} download>
                <DownloadIcon />
                {k.export}
              </a>
            </Button>
          </div>
        </div>
        {check.error && <Notice tone="bad">{check.error}</Notice>}
        {!data.signs && <Notice>{k.unsigned}</Notice>}
        {data.checkedOk === false && (
          <Notice tone="bad" title={k.brokenTitle}>
            <p>
              {broken ? k.why[broken.why] : k.why.changed}
              {broken?.chainNo != null && (
                <>
                  {" "}
                  {k.at(
                    number(broken.chainNo),
                    broken.time ? dateTime(broken.time) : "",
                    broken.action ? (t.events[broken.action] ?? broken.action) : "",
                  )}
                </>
              )}
            </p>
            <p className="mt-1">{k.brokenNext}</p>
          </Notice>
        )}
        <ForwardLine forward={data.forward} canManage={canManage} onEdit={() => setEditing(true)} />
      </CardContent>
      {editing && (
        <ForwardEditor
          forward={data.forward}
          records={data.records}
          canSeal={data.canSeal}
          onClose={(changed) => {
            setEditing(false);
            if (changed) void chain.reload();
          }}
        />
      )}
    </Card>
  );
}

function ForwardLine({
  forward,
  canManage,
  onEdit,
}: {
  forward: AuditForward | null;
  canManage: boolean;
  onEdit(): void;
}) {
  const { t, ago, number } = useI18n();
  const f = t.audit.forward;
  const host = forward ? new URL(forward.url).host : "";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-2.5 py-1.5">
      <SendIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        {!forward ? (
          <>
            <span className="text-[13px] font-medium">{f.none}</span>
            <Lead as="span" className="text-sm text-muted-foreground">
              {f.noneLead}
            </Lead>
          </>
        ) : (
          <>
            <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
              <span className="truncate">{f.to(host, f.kinds[forward.kind] ?? forward.kind)}</span>
              {!forward.enabled ? (
                <Badge variant="muted">{f.paused}</Badge>
              ) : forward.stalled ? (
                <Badge variant="destructive">{f.stalled}</Badge>
              ) : forward.error ? (
                <Badge variant="destructive">{f.failing}</Badge>
              ) : forward.behind > 0 ? (
                <Badge variant="warn">{f.behind(number(forward.behind))}</Badge>
              ) : (
                <Badge variant="ok">{f.upToDate}</Badge>
              )}
            </span>
            <span className="text-sm text-muted-foreground">
              {forward.deliveredAt ? f.delivered(ago(forward.deliveredAt)) : f.neverDelivered}
              {forward.enabled && forward.error && (
                <>
                  {" · "}
                  <span className="text-destructive">
                    {f.error(forward.error, number(forward.failures))}
                  </span>
                  {forward.behind > 0 && ` ${f.waiting(number(forward.behind))}`}
                </>
              )}
              {forward.enabled && forward.stalled && ` ${f.stalledLead(forward.purgeWaitsDays)}`}
              {!forward.enabled && ` · ${f.pausedLead}`}
            </span>
          </>
        )}
      </div>
      {canManage && (
        <Button variant="outline" size="sm" onClick={onEdit}>
          {forward ? f.change : f.setUp}
        </Button>
      )}
    </div>
  );
}

function ForwardEditor({
  forward,
  records,
  canSeal,
  onClose,
}: {
  forward: AuditForward | null;
  records: number;
  canSeal: boolean;
  onClose(changed: boolean): void;
}) {
  const { t, number } = useI18n();
  const f = t.audit.forward;
  const [kind, setKind] = useState<AuditForward["kind"]>(forward?.kind ?? "json");
  const [url, setUrl] = useState(forward?.url ?? "");
  const [token, setToken] = useState("");
  const [dropToken, setDropToken] = useState(false);
  const [enabled, setEnabled] = useState(forward?.enabled ?? true);
  const [start, setStart] = useState<"now" | "beginning">("now");
  const [tested, setTested] = useState<{ ok: boolean; problem: string | null } | null>(null);
  const [changed, setChanged] = useState(false);
  const save = useAction();
  const test = useAction();
  const asking = useConfirm();
  const body = () => ({
    kind,
    url: url.trim(),
    enabled,
    ...(token ? { token } : dropToken ? { token: "" } : {}),
    ...(forward ? {} : { start }),
  });
  const put = () => api("/api/audit/forward", { method: "PUT", body: JSON.stringify(body()) });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(changed)}>
      <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{f.title}</DialogTitle>
          <DialogDescription>{f.lead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label className="grid gap-1.5">
            {f.kind}
            <NativeSelect
              value={kind}
              onChange={(event) => setKind(event.target.value as AuditForward["kind"])}
            >
              <option value="json">{f.kinds.json}</option>
              <option value="splunk">{f.kinds.splunk}</option>
            </NativeSelect>
            <Lead as="span" className="text-xs font-normal text-muted-foreground">
              {f.kindHint[kind]}
            </Lead>
          </Label>
          <Label className="grid gap-1.5">
            {f.address}
            <Input
              className="font-mono text-[13px]"
              value={url}
              maxLength={500}
              placeholder={
                kind === "splunk"
                  ? "https://http-inputs-acme.splunkcloud.com/services/collector/event"
                  : "https://siem.example.com/muster"
              }
              onChange={(event) => setUrl(event.target.value)}
            />
            <Lead as="span" className="text-xs font-normal text-muted-foreground">
              {f.addressHint}
            </Lead>
          </Label>
          <Label className="grid gap-1.5">
            {f.token}
            <Input
              type="password"
              autoComplete="off"
              value={token}
              maxLength={2000}
              disabled={!canSeal || dropToken}
              placeholder={forward?.hasToken ? f.tokenKept : f.tokenNone}
              onChange={(event) => setToken(event.target.value)}
            />
            <Lead as="span" className="text-xs font-normal text-muted-foreground">
              {canSeal ? f.tokenHint[kind] : f.tokenUnsealed}
            </Lead>
          </Label>
          {forward?.hasToken && !token && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dropToken}
                onChange={(event) => setDropToken(event.target.checked)}
              />
              {f.tokenDrop}
            </label>
          )}
          {!forward && (
            <fieldset className="grid gap-2">
              <legend className="mb-1.5 text-[13px] font-medium">{f.start}</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={start === "now"}
                  onChange={() => setStart("now")}
                />
                {f.startNow}
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={start === "beginning"}
                  onChange={() => setStart("beginning")}
                />
                {f.startBeginning(number(records))}
              </label>
            </fieldset>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {f.on}
          </label>
          <Lead className="text-xs text-muted-foreground">{f.promise}</Lead>
          {tested &&
            (tested.ok ? (
              <Notice tone="ok">{f.testOk}</Notice>
            ) : (
              <Notice tone="bad">{f.testBad(tested.problem ?? "")}</Notice>
            ))}
          {(save.error || test.error) && <Notice tone="bad">{save.error ?? test.error}</Notice>}
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            {forward && (
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={save.busy}
                onClick={() =>
                  void asking.confirm(f.remove, f.removeConfirm).then((yes) =>
                    yes
                      ? save.run(async () => {
                          await api("/api/audit/forward", { method: "DELETE" });
                          onClose(true);
                        })
                      : undefined,
                  )
                }
              >
                {f.remove}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={!url.trim() || save.busy || test.busy}
              title={f.testHint}
              onClick={() =>
                void test.run(async () => {
                  setTested(null);
                  // What is tried is what is on the form, so it is saved first.
                  await put();
                  setChanged(true);
                  setToken("");
                  setTested(
                    await api<{ ok: boolean; problem: string | null }>("/api/audit/forward/test", {
                      method: "POST",
                    }),
                  );
                })
              }
            >
              {test.busy ? f.testing : f.test}
            </Button>
            <Button
              disabled={!url.trim() || save.busy || test.busy}
              onClick={() =>
                void save.run(async () => {
                  await put();
                  onClose(true);
                })
              }
            >
              {t.common.save}
            </Button>
          </div>
        </DialogFooter>
        {asking.dialog}
      </DialogContent>
    </Dialog>
  );
}
