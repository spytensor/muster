import { DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Empty, Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { type AdminEvent, api, type Me } from "@/lib/api";
import { eventSummary, eventTarget } from "@/lib/events";
import { AuditChainCard } from "./AuditChain";

const PAGE = 50;

export function AuditPage({ me }: { me: Me }) {
  const i18n = useI18n();
  const { t, dateTime } = i18n;
  const actionLabel = t.events;
  const [older, setOlder] = useState<AdminEvent[]>([]);
  const [done, setDone] = useState(false);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // What is typed is looked for in the whole record, on the server, a moment after typing stops.
  const [asked, setAsked] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  // People search in the words they see, so the actions whose name here holds the words go along.
  const named = asked
    ? Object.entries(actionLabel)
        .filter(([, label]) => label.toLowerCase().includes(asked.toLowerCase()))
        .map(([action]) => action)
        .slice(0, 60)
    : [];
  const filter = new URLSearchParams({
    ...(asked ? { q: asked } : {}),
    ...(named.length ? { actions: named.join(",") } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }).toString();
  const { data, error } = useLoad(() => {
    setOlder([]);
    setDone(false);
    return api<AdminEvent[]>(`/api/audit?limit=${PAGE}&${filter}`);
  }, [filter]);
  const more = useAction();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const rows = [...data, ...older];
  const last = rows.at(-1);
  const exhausted = done || data.length < PAGE;
  return (
    <>
      <AuditChainCard canManage={me.permissions.includes("settings.manage")} from={from} to={to} />
      <Card className="overflow-hidden pb-0 dense:pb-0">
        <CardHeader>
          <CardTitle>{t.audit.title}</CardTitle>
          <CardDescription>{t.audit.lead}</CardDescription>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-2 px-3.5">
          <Input
            className="sm:w-80"
            placeholder={t.audit.filter}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {t.audit.from}
            <Input
              aria-label={t.audit.from}
              type="date"
              className="w-40"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
            />
          </span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {t.audit.to}
            <Input
              aria-label={t.audit.to}
              type="date"
              className="w-40"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
            />
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            asChild
            title={t.audit.exportHint}
          >
            <a href={`/api/audit/export?${filter}`} download>
              <DownloadIcon />
              {t.audit.export}
            </a>
          </Button>
        </div>
        {rows.length === 0 ? (
          <Empty>{t.audit.none}</Empty>
        ) : (
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{t.audit.columns.time}</TableHead>
                <TableHead>{t.audit.columns.actor}</TableHead>
                <TableHead>{t.audit.columns.action}</TableHead>
                <TableHead>{t.audit.columns.target}</TableHead>
                <TableHead>{t.audit.columns.detail}</TableHead>
                <TableHead>{t.audit.columns.ip}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="num text-muted-foreground">
                    {dateTime(event.time)}
                  </TableCell>
                  <TableCell>{event.actorEmail}</TableCell>
                  <TableCell className="font-medium">
                    {actionLabel[event.action] ?? event.action}
                  </TableCell>
                  <TableCell>{eventTarget(event)}</TableCell>
                  <TableCell className="max-w-96 truncate text-muted-foreground">
                    {eventSummary(event, i18n)}
                  </TableCell>
                  <TableCell className="num text-muted-foreground">{event.ip ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!exhausted && last && (
          <div className="flex items-center justify-center gap-3 border-t py-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={more.busy}
              onClick={() =>
                void more.run(async () => {
                  const next = await api<AdminEvent[]>(
                    `/api/audit?limit=${PAGE}&before=${last.seq}&${filter}`,
                  );
                  setOlder((current) => [...current, ...next]);
                  if (next.length < PAGE) setDone(true);
                })
              }
            >
              {t.audit.more}
            </Button>
            {more.error && <span className="text-sm text-destructive">{more.error}</span>}
          </div>
        )}
      </Card>
    </>
  );
}
