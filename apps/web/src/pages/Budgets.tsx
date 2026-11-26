import { useState } from "react";
import { Notice, Person, useAction, useLoad } from "@/components/shared";
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
import { Input, Label } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import { Lead } from "@/components/ui/hint";

interface Budgets {
  month: string;
  canManage: boolean;
  priced: boolean;
  company: { limitMicros: number | null; spentMicros: number };
  everyone: { limitMicros: number | null };
  departments: {
    id: string;
    name: string;
    people: number;
    limitMicros: number | null;
    spentMicros: number;
  }[];
  people: {
    id: string;
    name: string;
    email: string;
    department: string | null;
    limitMicros: number | null;
    spentMicros: number;
  }[];
}
/** Whose limit is being set. */
interface Editing {
  scope: "company" | "department" | "everyone" | "person";
  targetId: string | null;
  label: string;
  limitMicros: number | null;
}

/** How much of a limit is spent: plain, then a warning from four fifths, then full. */
function Bar({ spent, limit }: { spent: number; limit: number }) {
  const share = limit > 0 ? spent / limit : 0;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, Math.round(share * 100))}
    >
      <div
        className={cn(
          "h-full rounded-full",
          share >= 1 ? "bg-destructive" : share >= 0.8 ? "bg-amber-500" : "bg-(--brand)",
        )}
        style={{ width: `${Math.min(100, share * 100)}%` }}
      />
    </div>
  );
}

function Editor({ editing, onClose }: { editing: Editing; onClose(changed: boolean): void }) {
  const { t } = useI18n();
  const b = t.budgets;
  const [amount, setAmount] = useState(
    editing.limitMicros === null ? "" : String(editing.limitMicros / 1_000_000),
  );
  const { error, busy, run } = useAction();
  // Dollars and cents, above nothing.
  const micros = /^\d{1,7}(\.\d{1,2})?$/.test(amount.trim())
    ? Math.round(Number(amount.trim()) * 1_000_000)
    : null;
  const put = (monthlyMicros: number | null) =>
    run(async () => {
      await api("/api/budgets", {
        method: "PUT",
        body: { scope: editing.scope, targetId: editing.targetId, monthlyMicros },
      });
      onClose(true);
    });
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose(false)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{b.editTitle(editing.label)}</DialogTitle>
          <DialogDescription>{b.editLead[editing.scope]}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label>{b.amount}</Label>
          <Input
            autoFocus
            inputMode="decimal"
            className="num"
            value={amount}
            placeholder="500"
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && micros && !busy) void put(micros);
            }}
          />
          <Lead className="text-xs text-muted-foreground">{b.amountHint}</Lead>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <DialogFooter className="sm:justify-between">
          {editing.limitMicros !== null ? (
            <Button variant="ghost" disabled={busy} onClick={() => void put(null)}>
              {b.removeLimit}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onClose(false)}>
              {t.common.cancel}
            </Button>
            <Button disabled={!micros || busy} onClick={() => micros && void put(micros)}>
              {t.common.save}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin console → Usage: this calendar month's spending against the limits the company
 * has set, for the company, each department and each person, and where they are set.
 */
export function BudgetsCard() {
  const { t, money, monthName } = useI18n();
  const b = t.budgets;
  const { data, error, reload } = useLoad(() => api<Budgets>("/api/budgets"));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [everyone, setEveryone] = useState(false);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return null;
  const limitCell = (
    own: number | null,
    spent: number,
    edit: Editing,
    fallback: number | null = null,
  ) => {
    const limit = own ?? fallback;
    return (
      <>
        <TableCell className="num text-right">{money(spent)}</TableCell>
        <TableCell className="min-w-40">
          {limit === null ? (
            <span className="text-muted-foreground">{b.none}</span>
          ) : (
            <div className="grid gap-1">
              <span className="num text-[13px]">
                {money(limit)}
                {own === null && <span className="text-muted-foreground"> · {b.everyones}</span>}
              </span>
              <Bar spent={spent} limit={limit} />
            </div>
          )}
        </TableCell>
        <TableCell className="text-right">
          {data.canManage && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(edit)}>
              {own === null ? b.set : b.change}
            </Button>
          )}
        </TableCell>
      </>
    );
  };
  // Without a limit of their own and with nothing spent, a person is only a row to scroll past.
  const people = everyone
    ? data.people
    : data.people.filter((one) => one.limitMicros !== null || one.spentMicros > 0);
  const company = data.company;
  return (
    <Card className="overflow-hidden pb-0 dense:pb-0">
      <CardHeader>
        <CardTitle>{b.title(monthName(data.month))}</CardTitle>
        <CardDescription>{b.lead}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 pb-2">
        {!data.priced && <Notice>{b.unpriced}</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid content-start gap-2 rounded-lg border px-2.5 py-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium">{b.company}</span>
              {data.canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setEditing({
                      scope: "company",
                      targetId: null,
                      label: b.company,
                      limitMicros: company.limitMicros,
                    })
                  }
                >
                  {company.limitMicros === null ? b.set : b.change}
                </Button>
              )}
            </div>
            <p className="num text-2xl font-semibold tracking-tight">
              {money(company.spentMicros)}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                {company.limitMicros === null ? b.noLimit : b.of(money(company.limitMicros))}
              </span>
            </p>
            {company.limitMicros !== null && (
              <Bar spent={company.spentMicros} limit={company.limitMicros} />
            )}
          </div>
          <div className="grid content-start gap-2 rounded-lg border px-2.5 py-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium">{b.everyone}</span>
              {data.canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setEditing({
                      scope: "everyone",
                      targetId: null,
                      label: b.everyone,
                      limitMicros: data.everyone.limitMicros,
                    })
                  }
                >
                  {data.everyone.limitMicros === null ? b.set : b.change}
                </Button>
              )}
            </div>
            <p className="num text-2xl font-semibold tracking-tight">
              {data.everyone.limitMicros === null ? (
                <span className="text-sm font-normal text-muted-foreground">{b.none}</span>
              ) : (
                money(data.everyone.limitMicros)
              )}
            </p>
            <Lead className="text-xs text-muted-foreground">{b.everyoneLead}</Lead>
          </div>
        </div>
        <Lead className="text-xs text-muted-foreground">{b.how}</Lead>
      </CardContent>
      {data.departments.length > 0 && (
        <Table pinLast className="border-t">
          <TableHeader>
            <TableRow>
              <TableHead>{b.columns.department}</TableHead>
              <TableHead className="text-right">{b.columns.spent}</TableHead>
              <TableHead>{b.columns.limit}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.departments.map((one) => (
              <TableRow key={one.id}>
                <TableCell>
                  <span className="font-medium">{one.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t.common.people(one.people)}
                  </span>
                </TableCell>
                {limitCell(one.limitMicros, one.spentMicros, {
                  scope: "department",
                  targetId: one.id,
                  label: one.name,
                  limitMicros: one.limitMicros,
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Table pinLast className="border-t">
        <TableHeader>
          <TableRow>
            <TableHead>{b.columns.person}</TableHead>
            <TableHead className="text-right">{b.columns.spent}</TableHead>
            <TableHead>{b.columns.limit}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.map((one) => (
            <TableRow key={one.id}>
              <TableCell>
                <Person name={one.name} email={one.email} />
              </TableCell>
              {limitCell(
                one.limitMicros,
                one.spentMicros,
                {
                  scope: "person",
                  targetId: one.id,
                  label: one.name || one.email,
                  limitMicros: one.limitMicros,
                },
                data.everyone.limitMicros,
              )}
            </TableRow>
          ))}
          {people.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                {b.nobody}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data.people.length > people.length || everyone ? (
        <div className="border-t px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setEveryone((now) => !now)}>
            {everyone ? b.showSome : b.showAll(data.people.length)}
          </Button>
        </div>
      ) : null}
      {editing && (
        <Editor
          editing={editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
        />
      )}
    </Card>
  );
}
