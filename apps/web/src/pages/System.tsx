import { LevelBadge, Loading, Notice, SettingRow, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { api, type Level, type Me } from "@/lib/api";
import { ToolPolicy } from "@/pages/ToolPolicy";
import { ModelSettingsCards } from "@/pages/ModelSettings";

interface System {
  model: null | {
    id: string;
    api: string;
    host: string;
    vision: boolean;
    second: { id: string; host: string } | null;
    inputPrice: number;
    outputPrice: number;
  };
  search: null | { provider: "searxng" | "tavily" | "search1api"; host: string };
  limits: {
    dailyTokensPerUser: number;
    approvalMinutes: number;
    maxFileBytes: number;
  };
  files: {
    count: number;
    bytes: number;
    quotaBytes: number;
    byPerson: { email: string; name: string; count: number; bytes: number }[];
  };
  rules: { level: Level; effect: "allow" | "ask" | "deny" }[];
  tools: { name: string; level: Level }[];
}
const useSystem = () => useLoad(() => api<System>("/api/system"));

/** A fact about the running server: one row (shared.tsx, `SettingRow`). */
const Fact = SettingRow;

/** The model agents run on, the limits in force and what is stored. Read from the running server. */
export function ModelsPage() {
  const { t, number, money } = useI18n();
  const s = t.system;
  const { data, error, reload } = useSystem();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  // Prices are dollars per million tokens; money() takes millionths of a dollar.
  const price = (dollars: number) => money(dollars * 1_000_000);
  return (
    <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      <ModelSettingsCards onChanged={() => void reload()} />
      <Card>
        <CardHeader>
          <CardTitle>{s.model.title}</CardTitle>
          <CardDescription>{s.model.lead}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.model ? (
            <>
              <Fact label={s.model.id}>
                <span className="font-mono text-[13px]">{data.model.id}</span>
              </Fact>
              <Fact label={s.model.endpoint}>
                <span className="font-mono text-[13px]">{data.model.host}</span>
              </Fact>
              <Fact label={s.model.protocol}>{data.model.api}</Fact>
              <Fact label={s.model.second}>
                {data.model.second ? (
                  <span className="font-mono text-[13px]">
                    {data.model.second.id} · {data.model.second.host}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{s.model.noSecond}</span>
                )}
              </Fact>
              <Fact label={s.model.vision}>
                <Badge variant={data.model.vision ? "ok" : "muted"}>
                  {data.model.vision ? s.model.yes : s.model.no}
                </Badge>
              </Fact>
              <Fact label={s.model.price}>
                {data.model.inputPrice || data.model.outputPrice
                  ? s.model.priceValue(price(data.model.inputPrice), price(data.model.outputPrice))
                  : s.model.priceUnset}
              </Fact>
            </>
          ) : (
            <Notice tone="bad">{s.model.none}</Notice>
          )}
          <Fact label={s.model.search} {...(data.search ? {} : { lead: s.model.searchNone })}>
            {data.search ? (
              <span className="font-mono text-[13px]">
                {
                  { search1api: "Search1API", tavily: "Tavily", searxng: "SearXNG" }[
                    data.search.provider
                  ]
                }{" "}
                · {data.search.host}
              </span>
            ) : (
              <Badge variant="muted">{s.model.no}</Badge>
            )}
          </Fact>
        </CardContent>
      </Card>
      <div className="grid gap-3 2xl:col-span-2 2xl:grid-cols-2 2xl:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{s.limits.title}</CardTitle>
            <CardDescription>{s.limits.lead}</CardDescription>
          </CardHeader>
          <CardContent>
            <Fact label={s.limits.daily} lead={s.limits.dailyLead}>
              {data.limits.dailyTokensPerUser > 0
                ? number(data.limits.dailyTokensPerUser)
                : s.limits.dailyNone}
            </Fact>
            <Fact label={s.limits.approval}>{s.limits.minutes(data.limits.approvalMinutes)}</Fact>
            <Fact label={s.limits.file}>{t.files.size(data.limits.maxFileBytes)}</Fact>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{s.files.title}</CardTitle>
            <CardDescription>{s.files.lead}</CardDescription>
          </CardHeader>
          <CardContent>
            <Fact label={s.files.title}>
              {s.files.stored(data.files.count, t.files.size(data.files.bytes))}
            </Fact>
            <Fact label={s.files.quota}>{t.files.size(data.files.quotaBytes)}</Fact>
            {data.files.byPerson.length > 0 && (
              <table className="num mt-3 w-full text-[13px]">
                <caption className="pb-1 text-left text-xs text-muted-foreground">
                  {s.files.byPerson}
                </caption>
                <tbody>
                  {data.files.byPerson.map((person) => (
                    <tr key={person.email} className="border-t">
                      <td className="py-1.5">{person.name || person.email}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{person.count}</td>
                      <td className="py-1.5 text-right">{t.files.size(person.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const effectVariant = { allow: "ok", ask: "warn", deny: "destructive" } as const;

/** The rules the gateway applies to every tool call, and the level of each tool. Read from the running server. */
export function PoliciesPage({ me }: { me: Me }) {
  const { t } = useI18n();
  const r = t.system.rules;
  const { data, error } = useSystem();
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  return (
    <div className="grid gap-3">
      <ToolPolicy me={me} />
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>{r.title}</CardTitle>
            <CardDescription>{r.lead}</CardDescription>
          </CardHeader>
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{r.level}</TableHead>
                <TableHead>{r.reach}</TableHead>
                <TableHead>{r.effect}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rules.map((rule) => (
                <TableRow key={rule.level}>
                  <TableCell>
                    <LevelBadge level={rule.level} />
                  </TableCell>
                  <TableCell>{t.level[rule.level] ?? ""}</TableCell>
                  <TableCell>
                    <Badge variant={effectVariant[rule.effect]}>{r.effects[rule.effect]}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <CardContent className="pt-2">
            <Notice>{r.unlisted}</Notice>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>{r.tools}</CardTitle>
          </CardHeader>
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{r.tool}</TableHead>
                <TableHead>{r.level}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.tools.map((tool) => (
                <TableRow key={tool.name}>
                  <TableCell className="font-mono text-[13px]">{tool.name}</TableCell>
                  <TableCell>
                    <LevelBadge level={tool.level} />
                  </TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {t.app.toolSummary[tool.name] ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
