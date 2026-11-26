import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Empty, Loading, Notice, useAction, useLoad } from "@/components/shared";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { Lead } from "@/components/ui/hint";

interface Shown {
  id: string;
  api: string;
  host: string;
  inputMicros: number;
  outputMicros: number;
  cachedInputMicros: number | null;
  cacheWriteMicros: number | null;
  vision: boolean;
  second: { id: string; host: string } | null;
}
interface Service {
  id: string;
  name: string;
  api: "anthropic" | "openai";
  baseUrl: string;
  hasKey: boolean;
  keyTail: string;
  keySetAt: string | null;
  models: number;
}
interface Choice {
  id: string;
  serviceId: string;
  model: string;
  inputMicros: number;
  outputMicros: number;
  cachedInputMicros: number | null;
  cacheWriteMicros: number | null;
  vision: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: string | null;
  role: "first" | "second" | null;
  testedAt: string | null;
  testedOk: boolean | null;
  testedNote: string | null;
}
export interface ModelsData {
  canSeal: boolean;
  canManage: boolean;
  source: "console" | "env" | "none";
  problem: "key_unreadable" | "no_key" | "second_unusable" | null;
  inEffect: Shown | null;
  env: Shown | null;
  services: Service[];
  models: Choice[];
}
interface TestResult {
  ok: boolean;
  code: string;
  status: number | null;
  detail: string;
  ms: number;
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_ADDRESS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

/** Dollars a million tokens as typed, to the whole millionths the server keeps. Null when it is not a price. */
function toMicros(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,4}(\.\d{1,6})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 1_000_000);
}
const fromMicros = (micros: number | null) => (micros === null ? "" : String(micros / 1_000_000));

/** One service models are bought from: where it is and the key it is asked with. */
function ServiceEditor({
  service,
  canSeal,
  onClose,
}: {
  service: Service | null;
  canSeal: boolean;
  onClose(changed: boolean): void;
}) {
  const { t, dateTime } = useI18n();
  const m = t.models;
  const [name, setName] = useState(service?.name ?? "");
  const [kind, setKind] = useState<"anthropic" | "openai">(service?.api ?? "openai");
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? DEFAULT_ADDRESS.openai);
  // Never sent back by the server: what is typed here replaces what is kept.
  const [key, setKey] = useState("");
  const { error, busy, run } = useAction();
  const moved = Boolean(service?.hasKey && baseUrl.trim().replace(/\/+$/, "") !== service.baseUrl);
  const ready =
    name.trim() && /^https?:\/\/.+/.test(baseUrl.trim()) && (!moved || key.trim()) && !busy;
  const save = () =>
    run(async () => {
      await api(service ? `/api/models/services/${service.id}` : "/api/models/services", {
        method: service ? "PATCH" : "POST",
        body: {
          name,
          api: kind,
          baseUrl: baseUrl.trim(),
          ...(key.trim() ? { key: key.trim() } : {}),
        },
      });
      onClose(true);
    });
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{service ? m.service.edit : m.service.add}</DialogTitle>
          <DialogDescription>{m.service.lead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>{m.service.name}</Label>
            <Input
              value={name}
              maxLength={60}
              placeholder={m.service.nameHint}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{m.service.kind}</Label>
            <NativeSelect
              value={kind}
              onChange={(e) => {
                const next = e.target.value as "anthropic" | "openai";
                // The usual address follows the kind, unless one was typed.
                if (!service && baseUrl === DEFAULT_ADDRESS[kind])
                  setBaseUrl(DEFAULT_ADDRESS[next]);
                setKind(next);
              }}
            >
              <option value="openai">{m.service.kinds.openai}</option>
              <option value="anthropic">{m.service.kinds.anthropic}</option>
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label>{m.service.address}</Label>
            <Input
              className="font-mono text-[13px]"
              value={baseUrl}
              maxLength={300}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <Lead className="text-xs text-muted-foreground">{m.service.addressHint[kind]}</Lead>
          </div>
          <div className="grid gap-1.5">
            <Label>{m.service.key}</Label>
            <Input
              type="password"
              autoComplete="off"
              className="font-mono text-[13px]"
              value={key}
              disabled={!canSeal}
              placeholder={
                service?.hasKey && !moved ? m.service.keyKept(service.keyTail) : m.service.keyHint
              }
              onChange={(e) => setKey(e.target.value)}
            />
            <Lead className="text-xs text-muted-foreground">
              {service?.hasKey && service.keySetAt && !moved
                ? m.service.keySet(dateTime(service.keySetAt))
                : m.service.keyLead}
            </Lead>
          </div>
          {!canSeal && <Notice tone="bad">{m.noSeal}</Notice>}
          {moved && <Notice>{m.service.moved}</Notice>}
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button disabled={!ready} onClick={() => void save()}>
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One model of a service: its name there, what it costs and what it can do. */
function ChoiceEditor({
  choice,
  services,
  onClose,
}: {
  choice: Choice | null;
  services: Service[];
  onClose(changed: boolean): void;
}) {
  const { t } = useI18n();
  const m = t.models;
  const [serviceId, setServiceId] = useState(choice?.serviceId ?? services[0]?.id ?? "");
  const [model, setModel] = useState(choice?.model ?? "");
  const [input, setInput] = useState(fromMicros(choice?.inputMicros ?? null));
  const [output, setOutput] = useState(fromMicros(choice?.outputMicros ?? null));
  const [cached, setCached] = useState(fromMicros(choice?.cachedInputMicros ?? null));
  const [write, setWrite] = useState(fromMicros(choice?.cacheWriteMicros ?? null));
  const [vision, setVision] = useState(choice?.vision ?? false);
  const [window, setWindow] = useState(choice?.contextWindow ? String(choice.contextWindow) : "");
  const [most, setMost] = useState(choice?.maxOutputTokens ? String(choice.maxOutputTokens) : "");
  const [effort, setEffort] = useState(choice?.reasoningEffort ?? "");
  const { error, busy, run } = useAction();
  const optional = (text: string) => (text.trim() ? toMicros(text) : null);
  const whole = (text: string, least: number, top: number) => {
    if (!text.trim()) return null;
    const value = Number(text.trim());
    return Number.isInteger(value) && value >= least && value <= top ? value : undefined;
  };
  const prices = {
    inputMicros: toMicros(input || "0"),
    outputMicros: toMicros(output || "0"),
    cachedInputMicros: optional(cached),
    cacheWriteMicros: optional(write),
  };
  const sizes = {
    contextWindow: whole(window, 8000, 4_000_000),
    maxOutputTokens: whole(most, 1024, 200_000),
  };
  const ready =
    serviceId &&
    /^[\x21-\x7e]{1,120}$/.test(model.trim()) &&
    prices.inputMicros !== null &&
    prices.outputMicros !== null &&
    (!cached.trim() || prices.cachedInputMicros !== null) &&
    (!write.trim() || prices.cacheWriteMicros !== null) &&
    sizes.contextWindow !== undefined &&
    sizes.maxOutputTokens !== undefined &&
    !busy;
  const save = () =>
    run(async () => {
      await api(choice ? `/api/models/choices/${choice.id}` : "/api/models/choices", {
        method: choice ? "PATCH" : "POST",
        body: {
          serviceId,
          model: model.trim(),
          ...prices,
          vision,
          ...sizes,
          reasoningEffort: effort || null,
        },
      });
      onClose(true);
    });
  const price = (label: string, value: string, set: (value: string) => void, hint?: string) => (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Input
        inputMode="decimal"
        className="num"
        value={value}
        placeholder={hint ?? "0"}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(false)}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{choice ? m.model.edit : m.model.add}</DialogTitle>
          <DialogDescription>{m.model.lead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>{m.model.service}</Label>
              <NativeSelect value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label>{m.model.name}</Label>
              <Input
                className="font-mono text-[13px]"
                value={model}
                maxLength={120}
                placeholder={m.model.nameHint}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Lead className="text-xs text-muted-foreground">{m.model.priceLead}</Lead>
            <div className="grid gap-3 sm:grid-cols-2">
              {price(m.model.input, input, setInput)}
              {price(m.model.output, output, setOutput)}
              {price(m.model.cached, cached, setCached, m.model.asInput)}
              {price(m.model.cacheWrite, write, setWrite, m.model.asInput)}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-(--brand)"
              checked={vision}
              onChange={(event) => setVision(event.target.checked)}
            />
            {m.model.vision}
          </label>
          <details className="grid gap-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {m.model.more}
            </summary>
            <div className="grid gap-3 pt-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label>{m.model.window}</Label>
                <Input
                  inputMode="numeric"
                  className="num"
                  value={window}
                  placeholder="128000"
                  onChange={(e) => setWindow(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{m.model.most}</Label>
                <Input
                  inputMode="numeric"
                  className="num"
                  value={most}
                  placeholder="16000"
                  onChange={(e) => setMost(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{m.model.effort}</Label>
                <NativeSelect value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">{m.model.effortUnset}</option>
                  {EFFORTS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          </details>
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t.common.cancel}
          </Button>
          <Button disabled={!ready} onClick={() => void save()}>
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin console → Models: the services models are bought from, the models of each, and
 * which one agents run on. What is chosen here replaces the model named in the server's
 * settings; while nothing is chosen, that one holds.
 */
export function ModelSettingsCards({ onChanged }: { onChanged(): void }) {
  const { t, money, ago } = useI18n();
  const m = t.models;
  const { data, error, reload } = useLoad(() => api<ModelsData>("/api/models"));
  const [service, setService] = useState<Service | "new" | null>(null);
  const [choice, setChoice] = useState<Choice | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, TestResult>>({});
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const changed = async () => {
    await reload();
    onChanged();
  };
  const first = data.models.find((one) => one.role === "first") ?? null;
  const second = data.models.find((one) => one.role === "second") ?? null;
  const serviceOf = (id: string) => data.services.find((one) => one.id === id);
  const price = (micros: number) => money(micros);
  const roles = (next: { first: string | null; second: string | null }, ask: string) =>
    action.run(async () => {
      if (!(await confirm(m.confirm, ask))) return;
      await api("/api/models/roles", { method: "PUT", body: next });
      await changed();
    });
  const remove = (path: string, ask: string) =>
    action.run(async () => {
      if (!(await confirm(t.common.remove, ask))) return;
      await api(path, { method: "DELETE" });
      await changed();
    });
  const test = async (one: Choice) => {
    setTesting(one.id);
    const result = await action.run(() =>
      api<TestResult>(`/api/models/choices/${one.id}/test`, { method: "POST" }),
    );
    setTesting(null);
    if (result) setTested((now) => ({ ...now, [one.id]: result }));
    await reload();
  };
  const said = (result: TestResult) =>
    result.ok
      ? m.test.ok(result.ms)
      : `${m.test.failed[result.code] ?? m.test.failed.error}${result.status ? ` (${result.status})` : ""}`;
  return (
    <>
      {dialog}
      {data.problem && <Notice tone="bad">{m.problem[data.problem]}</Notice>}
      {!data.canSeal && data.canManage && <Notice>{m.noSeal}</Notice>}
      {action.error && <Notice tone="bad">{action.error}</Notice>}
      <Card className="overflow-hidden pb-0 dense:pb-0 lg:col-span-2">
        <CardHeader>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <CardTitle>{m.title}</CardTitle>
              <CardDescription>
                {data.source === "console"
                  ? m.fromConsole
                  : data.source === "env"
                    ? m.fromEnv(data.env?.id ?? "")
                    : m.fromNowhere}
              </CardDescription>
            </div>
            {data.canManage && (
              <Button
                size="sm"
                className="shrink-0"
                disabled={data.services.length === 0}
                title={data.services.length === 0 ? m.model.needsService : undefined}
                onClick={() => setChoice("new")}
              >
                <PlusIcon />
                {m.model.add}
              </Button>
            )}
          </div>
        </CardHeader>
        {data.models.length === 0 ? (
          <Empty>{data.services.length === 0 ? m.emptyBoth : m.emptyModels}</Empty>
        ) : (
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{m.columns.model}</TableHead>
                <TableHead>{m.columns.service}</TableHead>
                <TableHead className="text-right">{m.columns.price}</TableHead>
                <TableHead>{m.columns.test}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.models.map((one) => {
                const at = serviceOf(one.serviceId);
                const result = tested[one.id];
                return (
                  <TableRow key={one.id}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px]">{one.model}</span>
                        {one.role && (
                          <Badge variant={one.role === "first" ? "ok" : "muted"}>
                            {m.role[one.role]}
                          </Badge>
                        )}
                        {one.vision && <Badge variant="muted">{m.model.sees}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      {at?.name}
                      {at && !at.hasKey && (
                        <span className="block text-xs text-destructive">{m.service.noKey}</span>
                      )}
                    </TableCell>
                    <TableCell className="num text-right">
                      {one.inputMicros || one.outputMicros ? (
                        m.model.priceValue(price(one.inputMicros), price(one.outputMicros))
                      ) : (
                        <span className="text-muted-foreground">{m.model.priceUnset}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal text-[13px]">
                      {testing === one.id ? (
                        <span className="text-muted-foreground">{m.test.running}</span>
                      ) : result ? (
                        <span className={result.ok ? "" : "text-destructive"}>
                          {said(result)}
                          {!result.ok && result.detail && (
                            <span className="block break-all text-xs text-muted-foreground">
                              {result.detail}
                            </span>
                          )}
                        </span>
                      ) : one.testedAt ? (
                        <span
                          className={one.testedOk ? "text-muted-foreground" : "text-destructive"}
                        >
                          {one.testedOk
                            ? m.test.wasOk(ago(one.testedAt))
                            : m.test.wasFailed(
                                m.test.failed[one.testedNote ?? "error"] ?? "",
                                ago(one.testedAt),
                              )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{m.test.never}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {data.canManage && (
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={testing !== null}
                            onClick={() => void test(one)}
                          >
                            {m.test.run}
                          </Button>
                          <MoreMenu
                            label={m.moreFor(one.model)}
                            items={[
                              ...(one.role !== "first"
                                ? [
                                    {
                                      label: m.makeFirst,
                                      onSelect: () =>
                                        void roles(
                                          {
                                            first: one.id,
                                            second:
                                              second && second.id !== one.id ? second.id : null,
                                          },
                                          m.confirmFirst(one.model),
                                        ),
                                    },
                                  ]
                                : []),
                              ...(first && one.role === null
                                ? [
                                    {
                                      label: m.makeSecond,
                                      onSelect: () =>
                                        void roles(
                                          { first: first.id, second: one.id },
                                          m.confirmSecond(one.model),
                                        ),
                                    },
                                  ]
                                : []),
                              ...(one.role === "second" && first
                                ? [
                                    {
                                      label: m.dropSecond,
                                      onSelect: () =>
                                        void roles(
                                          { first: first.id, second: null },
                                          m.confirmDropSecond(one.model),
                                        ),
                                    },
                                  ]
                                : []),
                              { label: m.model.edit, onSelect: () => setChoice(one) },
                              ...(one.role
                                ? []
                                : [
                                    {
                                      label: t.common.remove,
                                      destructive: true,
                                      onSelect: () =>
                                        void remove(
                                          `/api/models/choices/${one.id}`,
                                          m.model.removeConfirm(one.model),
                                        ),
                                    },
                                  ]),
                            ]}
                          />
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {data.canManage && first && (
          <CardContent className="border-t py-1.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Lead className="text-[13px] text-muted-foreground">
                {data.env ? m.backLead(data.env.id) : m.backLeadNone}
              </Lead>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void roles(
                    { first: null, second: null },
                    data.env ? m.confirmBack(data.env.id) : m.confirmBackNone,
                  )
                }
              >
                {m.back}
              </Button>
            </div>
          </CardContent>
        )}
      </Card>
      <Card className="overflow-hidden pb-0 dense:pb-0 lg:col-span-2 2xl:col-span-1">
        <CardHeader>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <CardTitle>{m.service.title}</CardTitle>
              <CardDescription>{m.service.cardLead}</CardDescription>
            </div>
            {data.canManage && (
              <Button size="sm" className="shrink-0" onClick={() => setService("new")}>
                <PlusIcon />
                {m.service.add}
              </Button>
            )}
          </div>
        </CardHeader>
        {data.services.length === 0 ? (
          <Empty>{m.service.empty}</Empty>
        ) : (
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{m.service.name}</TableHead>
                <TableHead>{m.service.address}</TableHead>
                <TableHead>{m.service.key}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.services.map((one) => (
                <TableRow key={one.id}>
                  <TableCell>
                    <span className="font-medium">{one.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {m.service.kinds[one.api]} · {m.service.models(one.models)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{one.baseUrl}</TableCell>
                  <TableCell>
                    {one.hasKey ? (
                      <span className="text-[13px]">
                        <span className="font-mono">
                          ••••{one.keyTail ? ` ${one.keyTail}` : ""}
                        </span>
                        {one.keySetAt && (
                          <span className="block text-xs text-muted-foreground">
                            {m.service.keySetAgo(ago(one.keySetAt))}
                          </span>
                        )}
                      </span>
                    ) : (
                      <Badge variant="destructive">{m.service.noKey}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {data.canManage && (
                      <MoreMenu
                        label={m.moreFor(one.name)}
                        items={[
                          { label: m.service.edit, onSelect: () => setService(one) },
                          ...(one.models === 0
                            ? [
                                {
                                  label: t.common.remove,
                                  destructive: true,
                                  onSelect: () =>
                                    void remove(
                                      `/api/models/services/${one.id}`,
                                      m.service.removeConfirm(one.name),
                                    ),
                                },
                              ]
                            : []),
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
      {service && (
        <ServiceEditor
          service={service === "new" ? null : service}
          canSeal={data.canSeal}
          onClose={(saved) => {
            setService(null);
            if (saved) void changed();
          }}
        />
      )}
      {choice && (
        <ChoiceEditor
          choice={choice === "new" ? null : choice}
          services={data.services}
          onClose={(saved) => {
            setChoice(null);
            if (saved) void changed();
          }}
        />
      )}
    </>
  );
}
