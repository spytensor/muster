import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Empty, Loading, Notice, Person, RiskBadge, useAction, useLoad } from "@/components/shared";
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
import { Label, NativeSelect, Textarea } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { api, type Me, type Member, type Risk } from "@/lib/api";
import { Lead } from "@/components/ui/hint";

type Kind = "agent" | "skill" | "knowledge";
interface Listing {
  kind: Kind;
  id: string;
  name: string;
  description: string;
  risk: Risk | null;
  ready: boolean;
  state: "pending" | "published" | "returned" | "withdrawn" | "changed";
  note: string;
  reason: string;
  departments: string[];
  defaults: string[];
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  by: { name: string; email: string } | null;
  adds: number;
  /** The version shown here. Approving is of this one. */
  version: string;
  content: {
    instructions?: string;
    tools?: string[];
    carries?: { kind: string; name: string }[];
    texts?: { name: string; text: string }[];
    findings?: { rule: string; excerpt: string }[];
    documents?: string[];
  } | null;
}
interface Rules {
  build: boolean;
  share: boolean;
  submit: boolean;
  reach: "R1" | "R2" | "R3";
}
interface Department {
  id: string;
  name: string;
}

/** Sending something back, or taking it down: its maker reads the reason. */
function Reason({
  listing,
  decision,
  onClose,
}: {
  listing: Listing;
  decision: "return" | "take_down";
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const m = t.market;
  const [reason, setReason] = useState("");
  const { error, busy, run } = useAction();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {decision === "return" ? m.returnTitle(listing.name) : m.takeDownTitle(listing.name)}
          </DialogTitle>
          <DialogDescription>
            {decision === "return" ? m.returnLead : m.takeDownLead(listing.adds)}
          </DialogDescription>
        </DialogHeader>
        <Label className="grid gap-1.5">
          {m.reason}
          <Textarea
            value={reason}
            maxLength={500}
            placeholder={m.reasonHint}
            onChange={(event) => setReason(event.target.value)}
          />
        </Label>
        {error && <Notice tone="bad">{error}</Notice>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button
            variant={decision === "take_down" ? "destructive" : "default"}
            disabled={!reason.trim() || busy}
            onClick={() =>
              void run(async () => {
                await api(`/api/market/${listing.kind}/${listing.id}/decide`, {
                  method: "POST",
                  body: { decision, reason },
                });
                onClose(true);
              })
            }
          >
            {decision === "return" ? m.sendBack : m.takeDown}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The thing itself, as a reviewer reads it before deciding. */
function Content({ listing, onClose }: { listing: Listing; onClose(): void }) {
  const { t } = useI18n();
  const m = t.market;
  const c = listing.content ?? {};
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{listing.name}</DialogTitle>
          <DialogDescription>{listing.description || m.noDescription}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          {c.instructions !== undefined && (
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">{m.instructions}</span>
              <pre className="max-h-72 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                {c.instructions}
              </pre>
            </div>
          )}
          {c.tools && (
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">{m.tools}</span>
              <div className="flex flex-wrap gap-1.5">
                {c.tools.length === 0 && <span className="text-xs">—</span>}
                {c.tools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
          {c.carries && c.carries.length > 0 && (
            <div className="grid gap-1">
              <Lead as="span" className="text-xs font-medium text-muted-foreground">
                {m.carries}
              </Lead>
              <div className="flex flex-wrap gap-1.5">
                {c.carries.map((part) => (
                  <span
                    key={`${part.kind}:${part.name}`}
                    className="rounded-full border px-2 py-0.5 text-xs"
                  >
                    {part.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          {c.texts?.map((text) => (
            <div key={text.name} className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">{text.name}</span>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                {text.text}
              </pre>
            </div>
          ))}
          {c.findings && c.findings.length > 0 && (
            <Notice tone="info" title={m.findings}>
              {c.findings.map((finding) => `${finding.rule}: …${finding.excerpt}…`).join("\n")}
            </Notice>
          )}
          {c.documents && (
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {m.documents(c.documents.length)}
              </span>
              <ul className="grid gap-0.5 text-[13px]">
                {c.documents.map((name, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; the list is fixed
                  <li key={index}>{name}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t.common.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Who a published thing is for, and whose people have it from the start. */
function Reach({
  listing,
  departments,
  onClose,
}: {
  listing: Listing;
  departments: Department[];
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const m = t.market;
  const [open, setOpen] = useState(listing.departments);
  const [given, setGiven] = useState(listing.defaults);
  const { error, busy, run } = useAction();
  const flip = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((item) => item !== id);
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.reachTitle(listing.name)}</DialogTitle>
          <DialogDescription>{m.reachLead}</DialogDescription>
        </DialogHeader>
        <Table pinLast>
          <TableHeader>
            <TableRow>
              <TableHead>{m.department}</TableHead>
              <TableHead className="text-center">{m.canSee}</TableHead>
              <TableHead className="text-center">{m.startsWith}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.map((department) => (
              <TableRow key={department.id}>
                <TableCell>{department.name}</TableCell>
                <TableCell className="text-center">
                  <input
                    type="checkbox"
                    className="size-4 accent-(--brand)"
                    aria-label={`${m.canSee}: ${department.name}`}
                    checked={open.length === 0 || open.includes(department.id)}
                    disabled={open.length === 0}
                    onChange={(event) => {
                      setOpen((now) => flip(now, department.id, event.target.checked));
                      if (!event.target.checked)
                        setGiven((now) => now.filter((id) => id !== department.id));
                    }}
                  />
                </TableCell>
                <TableCell className="text-center">
                  <input
                    type="checkbox"
                    className="size-4 accent-(--brand)"
                    aria-label={`${m.startsWith}: ${department.name}`}
                    checked={given.includes(department.id)}
                    disabled={open.length > 0 && !open.includes(department.id)}
                    onChange={(event) =>
                      setGiven((now) => flip(now, department.id, event.target.checked))
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-(--brand)"
            checked={open.length === 0}
            onChange={(event) =>
              setOpen(event.target.checked ? [] : departments.map((department) => department.id))
            }
          />
          {m.wholeCompany}
        </label>
        {error && <Notice tone="bad">{error}</Notice>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/api/market/${listing.kind}/${listing.id}`, {
                  method: "PATCH",
                  body: { departments: open, defaults: given },
                });
                onClose(true);
              })
            }
          >
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the company offers its people: what waits for a decision, what is published and
 * who uses it, the rules for members, and handing one person's things to another.
 */
export function MarketPage({ me }: { me: Me }) {
  const { t, ago, dateTime } = useI18n();
  const m = t.market;
  const { data, error, reload } = useLoad(() =>
    api<{ rules: Rules; listings: Listing[] }>("/api/market"),
  );
  const departments = useLoad(() => api<Department[]>("/api/departments"));
  const members = useLoad(() => api<Member[]>("/api/members"));
  const [asking, setAsking] = useState<{
    listing: Listing;
    decision: "return" | "take_down";
  } | null>(null);
  const [reaching, setReaching] = useState<Listing | null>(null);
  const [reading, setReading] = useState<Listing | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [handed, setHanded] = useState<string | null>(null);
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const decides = me.permissions.includes("agents.manage");
  const setsRules = me.permissions.includes("settings.manage");
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const waiting = data.listings.filter(
    (listing) => listing.state === "pending" || listing.state === "changed",
  );
  const published = data.listings.filter((listing) => listing.state === "published");
  const nameOf = (id: string) => departments.data?.find((d) => d.id === id)?.name ?? "…";
  const approve = (listing: Listing) =>
    action.run(async () => {
      await api(`/api/market/${listing.kind}/${listing.id}/decide`, {
        method: "POST",
        body: { decision: "approve", version: listing.version },
      });
      await reload();
    });
  const setRules = (patch: Partial<Rules>) =>
    action.run(async () => {
      await api("/api/settings/market", { method: "PUT", body: { ...data.rules, ...patch } });
      await reload();
    });
  const handOver = async () => {
    const giver = members.data?.find((member) => member.id === from);
    const taker = members.data?.find((member) => member.id === to);
    if (!giver || !taker) return;
    if (!(await confirm(m.handOver, m.handOverConfirm(giver.email, taker.email)))) return;
    await action.run(async () => {
      const result = await api<{ moved: Record<string, number> }>(`/api/members/${from}/handover`, {
        method: "POST",
        body: { to },
      });
      setHanded(
        m.handedOver(
          result.moved.agent ?? 0,
          result.moved.skill ?? 0,
          result.moved.knowledge ?? 0,
          taker.email,
        ),
      );
      setFrom("");
      setTo("");
    });
  };
  const closed = (changed: boolean) => {
    setAsking(null);
    setReaching(null);
    if (changed) void reload();
  };
  const what = (listing: Listing) => (
    <div className="grid gap-0.5">
      <span className="flex items-center gap-2 font-medium">
        {listing.name}
        <Badge variant="muted">{m.kind[listing.kind]}</Badge>
        {listing.risk && <RiskBadge risk={listing.risk} />}
      </span>
      <span className="line-clamp-1 max-w-md text-xs text-muted-foreground">
        {listing.description || m.noDescription}
      </span>
    </div>
  );
  const forWhom = (listing: Listing) =>
    listing.departments.length === 0 ? m.everyone : listing.departments.map(nameOf).join(", ");
  return (
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid gap-3">
        {action.error && <Notice tone="bad">{action.error}</Notice>}
        <Card className="overflow-hidden pb-0 dense:pb-0">
          <CardHeader>
            <CardTitle>{m.reviewTitle(waiting.length)}</CardTitle>
            <CardDescription>{m.reviewLead}</CardDescription>
          </CardHeader>
          {waiting.length === 0 ? (
            <Empty>{m.reviewNone}</Empty>
          ) : (
            <Table pinLast>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.columns.what}</TableHead>
                  <TableHead>{m.columns.by}</TableHead>
                  <TableHead>{m.columns.forWhom}</TableHead>
                  <TableHead>{m.columns.sent}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {waiting.map((listing) => (
                  <TableRow key={`${listing.kind}:${listing.id}`}>
                    <TableCell>
                      {what(listing)}
                      {listing.note && (
                        <p className="mt-1 max-w-md text-xs">
                          <span className="text-muted-foreground">{m.note}: </span>
                          {listing.note}
                        </p>
                      )}
                      {listing.state === "changed" && (
                        <Badge variant="warn" className="mt-1">
                          {m.changed}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Person name={listing.by?.name ?? ""} email={listing.by?.email ?? ""} />
                    </TableCell>
                    <TableCell className="text-[13px]">{forWhom(listing)}</TableCell>
                    <TableCell title={dateTime(listing.submittedAt)}>
                      {ago(listing.submittedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {decides && (
                        <span className="flex items-center justify-end gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => setReading(listing)}>
                            {m.read}
                          </Button>
                          <Button
                            size="sm"
                            disabled={action.busy || !listing.ready}
                            title={listing.ready ? undefined : m.notReady}
                            onClick={() => void approve(listing)}
                          >
                            {m.approve}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setAsking({ listing, decision: "return" })}
                          >
                            {m.sendBack}
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
        <Card className="overflow-hidden pb-0 dense:pb-0">
          <CardHeader>
            <CardTitle>{m.catalogueTitle(published.length)}</CardTitle>
            <CardDescription>{m.catalogueLead}</CardDescription>
          </CardHeader>
          {published.length === 0 ? (
            <Empty>{m.catalogueNone}</Empty>
          ) : (
            <Table pinLast>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.columns.what}</TableHead>
                  <TableHead>{m.columns.by}</TableHead>
                  <TableHead>{m.columns.forWhom}</TableHead>
                  <TableHead>{m.columns.given}</TableHead>
                  <TableHead className="text-right">{m.columns.adds}</TableHead>
                  <TableHead>{m.columns.since}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {published.map((listing) => (
                  <TableRow key={`${listing.kind}:${listing.id}`}>
                    <TableCell>{what(listing)}</TableCell>
                    <TableCell>
                      <Person name={listing.by?.name ?? ""} email={listing.by?.email ?? ""} />
                    </TableCell>
                    <TableCell className="text-[13px]">{forWhom(listing)}</TableCell>
                    <TableCell className="text-[13px]">
                      {listing.defaults.length ? listing.defaults.map(nameOf).join(", ") : "—"}
                    </TableCell>
                    <TableCell className="num text-right">{listing.adds}</TableCell>
                    <TableCell title={listing.decidedAt ? dateTime(listing.decidedAt) : undefined}>
                      {ago(listing.decidedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {decides && (
                        <MoreMenu
                          label={t.common.more}
                          items={[
                            { label: m.read, onSelect: () => setReading(listing) },
                            { label: m.setReach, onSelect: () => setReaching(listing) },
                            {
                              label: m.takeDown,
                              destructive: true,
                              onSelect: () => setAsking({ listing, decision: "take_down" }),
                            },
                          ]}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
      <div className="grid gap-3">
        <Card>
          <CardHeader>
            <CardTitle>{m.rulesTitle}</CardTitle>
            <CardDescription>{m.rulesLead}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {(["build", "share", "submit"] as const).map((rule) => (
              <label key={rule} className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-(--brand)"
                  checked={data.rules[rule]}
                  disabled={!setsRules || action.busy}
                  onChange={(event) => void setRules({ [rule]: event.target.checked })}
                />
                <span className="grid gap-0.5">
                  {m.rule[rule]}
                  <Lead as="span" className="text-xs text-muted-foreground">
                    {m.ruleLead[rule]}
                  </Lead>
                </span>
              </label>
            ))}
            <Label className="grid gap-1.5">
              {m.reachRule}
              <NativeSelect
                value={data.rules.reach}
                disabled={!setsRules || action.busy}
                onChange={(event) => void setRules({ reach: event.target.value as Rules["reach"] })}
              >
                {(["R1", "R2", "R3"] as const).map((risk) => (
                  <option key={risk} value={risk}>
                    {m.reachOption[risk]}
                  </option>
                ))}
              </NativeSelect>
              <Lead as="span" className="text-xs font-normal text-muted-foreground">
                {m.reachRuleLead}
              </Lead>
            </Label>
          </CardContent>
        </Card>
        {me.role === "owner" && (
          <Card>
            <CardHeader>
              <CardTitle>{m.handOver}</CardTitle>
              <CardDescription>{m.handOverLead}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Label className="grid gap-1.5">
                {m.from}
                <NativeSelect value={from} onChange={(event) => setFrom(event.target.value)}>
                  <option value="">{m.choose}</option>
                  {(members.data ?? []).map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name || member.email}
                      {member.status === "active" ? "" : ` (${t.status[member.status]})`}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
              <Label className="grid gap-1.5">
                {m.to}
                <NativeSelect value={to} onChange={(event) => setTo(event.target.value)}>
                  <option value="">{m.choose}</option>
                  {(members.data ?? [])
                    .filter((member) => member.status === "active" && member.id !== from)
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name || member.email}
                      </option>
                    ))}
                </NativeSelect>
              </Label>
              {handed && <Notice tone="ok">{handed}</Notice>}
              <div>
                <Button
                  variant="outline"
                  disabled={!from || !to || action.busy}
                  onClick={() => void handOver()}
                >
                  {m.handOver}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      {asking && <Reason listing={asking.listing} decision={asking.decision} onClose={closed} />}
      {reading && <Content listing={reading} onClose={() => setReading(null)} />}
      {reaching && (
        <Reach listing={reaching} departments={departments.data ?? []} onClose={closed} />
      )}
      {dialog}
    </div>
  );
}
