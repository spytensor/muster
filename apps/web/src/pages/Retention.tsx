import { useEffect, useState } from "react";
import { Loading, Notice, useAction, useLoad, SettingRow } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import {
  api,
  type Me,
  type RetentionCounts,
  type RetentionKind,
  type RetentionPeriods,
  type RetentionSettings,
} from "@/lib/api";
import { Lead } from "@/components/ui/hint";

const KINDS: RetentionKind[] = ["conversations", "files", "traces", "audit"];
/** The periods offered; any other number of days can be typed. */
const CHOICES = [30, 90, 180, 365, 730, 1095, 2555];

/**
 * How long things are kept, and the legal hold that stops their purging.
 * See docs/features/admin-console.md, "Retention and erasure".
 */
export function RetentionPage({ me }: { me: Me }) {
  const { t, dateTime, ago, number } = useI18n();
  const r = t.retention;
  const settings = useLoad(() => api<RetentionSettings>("/api/retention"));
  const canManage = me.permissions.includes("settings.manage");
  const [draft, setDraft] = useState<RetentionPeriods | null>(null);
  const [asking, setAsking] = useState<RetentionCounts | null>(null);
  const [holding, setHolding] = useState(false);
  const save = useAction();
  const data = settings.data;
  useEffect(() => {
    if (data) setDraft(data.periods);
  }, [data]);
  if (settings.error) return <Notice tone="bad">{settings.error}</Notice>;
  if (!data || !draft) return <Loading />;
  const changed = KINDS.some((kind) => draft[kind] !== data.periods[kind]);
  const valid = KINDS.every((kind) => {
    const days = draft[kind];
    return (
      days === null ||
      (Number.isInteger(days) && days >= data.limits[kind].min && days <= data.limits[kind].max)
    );
  });
  const put = () =>
    save.run(async () => {
      await api("/api/retention", { method: "PUT", body: JSON.stringify(draft) });
      setAsking(null);
      await settings.reload();
    });
  const total = (counts: RetentionCounts) => KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const counted = (counts: RetentionCounts) =>
    KINDS.filter((kind) => counts[kind] > 0)
      .map((kind) => r.count[kind]?.(number(counts[kind])) ?? "")
      .join(r.and);
  return (
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardHeader>
          <CardTitle>{r.title}</CardTitle>
          <CardDescription>{r.lead}</CardDescription>
          {canManage && (
            <CardAction>
              {changed && (
                <Button variant="ghost" size="sm" onClick={() => setDraft(data.periods)}>
                  {r.discard}
                </Button>
              )}
              <Button
                size="sm"
                disabled={!changed || !valid || save.busy}
                onClick={() =>
                  void save.run(async () => {
                    // What these periods would take, counted now, is said before anything is saved.
                    const would = await api<RetentionCounts>("/api/retention/preview", {
                      method: "POST",
                      body: JSON.stringify(draft),
                    });
                    setAsking(would);
                  })
                }
              >
                {r.review}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="grid">
          {data.hold && <Notice tone="bad">{r.heldNotice}</Notice>}
          {KINDS.map((kind) => {
            const days = draft[kind];
            const { min, max } = data.limits[kind];
            const listed = days === null || CHOICES.includes(days);
            return (
              <SettingRow
                key={kind}
                label={r.kinds[kind]}
                lead={r.what[kind]}
                below={
                  <>
                    {kind === "audit" && days !== null && data.auditPurge !== "ok" && (
                      <Notice tone="bad">
                        {data.auditPurge === "no_key" ? r.auditNoKey : r.auditOtherKey}
                      </Notice>
                    )}
                    {days !== null && !(days >= min && days <= max) && (
                      <p className="pb-1.5 text-xs text-destructive">{r.range(min, max)}</p>
                    )}
                    {days === data.periods[kind] && data.waiting[kind] > 0 && (
                      <p className="pb-1.5 text-xs text-muted-foreground">
                        {r.waiting(r.count[kind]?.(number(data.waiting[kind])) ?? "")}
                      </p>
                    )}
                  </>
                }
              >
                {days !== null && !listed && (
                  <Label className="flex items-center gap-1.5 font-normal">
                    <Input
                      aria-label={r.days}
                      type="number"
                      className="w-20"
                      min={min}
                      max={max}
                      disabled={!canManage}
                      value={Number.isNaN(days) ? "" : days}
                      onChange={(event) =>
                        setDraft({ ...draft, [kind]: event.target.valueAsNumber })
                      }
                    />
                    {r.days}
                  </Label>
                )}
                <NativeSelect
                  aria-label={r.kinds[kind]}
                  className="w-40"
                  disabled={!canManage}
                  value={days === null ? "" : listed ? String(days) : "other"}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft({
                      ...draft,
                      [kind]: value === "" ? null : value === "other" ? min : Number(value),
                    });
                  }}
                >
                  <option value="">{r.forever}</option>
                  {CHOICES.filter((choice) => choice >= min).map((choice) => (
                    <option key={choice} value={choice}>
                      {r.period(choice)}
                    </option>
                  ))}
                  <option value="other">{r.other}</option>
                </NativeSelect>
              </SettingRow>
            );
          })}
          {save.error && !asking && <Notice tone="bad">{save.error}</Notice>}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 lg:grid-rows-2">
        <Card>
          <CardHeader>
            <CardTitle>{r.purgeTitle}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p>
              {data.hold ? r.nextHeld : data.nextAt ? r.next(dateTime(data.nextAt)) : r.nextNone}
            </p>
            <p className="text-muted-foreground">
              {data.purgedAt
                ? data.purged && total(data.purged) > 0
                  ? r.last(ago(data.purgedAt), counted(data.purged))
                  : r.lastNothing(ago(data.purgedAt))
                : r.never}
            </p>
            {data.purged?.auditUnsent ? (
              <p className="text-destructive">{r.unsent(number(data.purged.auditUnsent))}</p>
            ) : null}
            <Lead className="text-xs text-muted-foreground">{r.purgeHow}</Lead>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {r.holdTitle}
              {data.hold ? (
                <Badge variant="warn">{r.holdOn}</Badge>
              ) : (
                <Badge variant="muted">{r.holdOff}</Badge>
              )}
            </CardTitle>
            <CardDescription>{r.holdLead}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {data.hold && (
              <div className="grid gap-1 rounded-lg border px-2.5 py-1.5">
                <span>{data.hold.reason}</span>
                <span className="text-xs text-muted-foreground">
                  {r.holdBy(data.hold.by ?? "", data.hold.at ? dateTime(data.hold.at) : "")}
                </span>
              </div>
            )}
            {canManage && (
              <div>
                <Button variant="outline" size="sm" onClick={() => setHolding(true)}>
                  {data.hold ? r.holdLift : r.holdPlace}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {asking && (
        <Dialog open onOpenChange={(open) => !open && setAsking(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{r.confirmTitle}</DialogTitle>
              <DialogDescription>{r.confirmLead}</DialogDescription>
            </DialogHeader>
            <ul className="grid gap-1 text-sm">
              {KINDS.filter((kind) => draft[kind] !== data.periods[kind]).map((kind) => (
                <li key={kind} className="flex justify-between gap-3">
                  <span>{r.kinds[kind]}</span>
                  <span className="text-muted-foreground">
                    {data.periods[kind] === null ? r.forever : r.period(data.periods[kind])}
                    {" → "}
                    <span className="font-medium text-foreground">
                      {draft[kind] === null ? r.forever : r.period(draft[kind])}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {total(asking) > 0 ? (
              <Notice tone="bad" title={r.willGoTitle}>
                {r.willGo(counted(asking))}
              </Notice>
            ) : (
              <Notice>{r.nothingYet}</Notice>
            )}
            <p className="text-sm text-muted-foreground">{data.hold ? r.graceHeld : r.grace}</p>
            {save.error && <Notice tone="bad">{save.error}</Notice>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setAsking(null)}>
                {t.common.cancel}
              </Button>
              <Button
                variant={total(asking) > 0 ? "destructive" : "default"}
                disabled={save.busy}
                onClick={() => void put()}
              >
                {r.confirm}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {holding && (
        <HoldDialog
          on={data.hold !== null}
          onClose={(done) => {
            setHolding(false);
            if (done) void settings.reload();
          }}
        />
      )}
    </div>
  );
}

function HoldDialog({ on, onClose }: { on: boolean; onClose(done: boolean): void }) {
  const { t } = useI18n();
  const r = t.retention;
  const [reason, setReason] = useState("");
  const action = useAction();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{on ? r.holdLift : r.holdPlace}</DialogTitle>
          <DialogDescription>{on ? r.holdLiftLead : r.holdPlaceLead}</DialogDescription>
        </DialogHeader>
        {!on && (
          <Label className="grid gap-1.5">
            {r.holdReason}
            <Textarea
              value={reason}
              maxLength={300}
              rows={3}
              placeholder={r.holdReasonHint}
              onChange={(event) => setReason(event.target.value)}
            />
          </Label>
        )}
        {action.error && <Notice tone="bad">{action.error}</Notice>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button
            disabled={action.busy || (!on && !reason.trim())}
            onClick={() =>
              void action.run(async () => {
                await api("/api/retention/hold", {
                  method: "PUT",
                  body: JSON.stringify(on ? { on: false } : { on: true, reason: reason.trim() }),
                });
                onClose(true);
              })
            }
          >
            {on ? r.holdLift : r.holdPlace}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
