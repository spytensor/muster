import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { MoreMenu } from "@/components/more";
import { Avatar, Empty, Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n";
import { api, type Dashboard, type Department, type Me, type Member } from "@/lib/api";
import { Lead } from "@/components/ui/hint";

/**
 * The organization's departments, each with who is in it and what its agents did and
 * cost in the last thirty days, and beside them the people who are in none.
 */
export function DepartmentsPage({ me }: { me: Me }) {
  const { t, number, money } = useI18n();
  const d = t.departments;
  const { data, error, reload } = useLoad(async () => {
    const [departments, members, usage] = await Promise.all([
      api<Department[]>("/api/departments"),
      api<Member[]>("/api/members"),
      // Cost is for those who may see runs; the page stands without it.
      api<Dashboard>("/api/dashboard?range=30d").catch(() => null),
    ]);
    return { departments, members, usage };
  });
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<Department | null>(null);
  const [removing, setRemoving] = useState<Department | null>(null);
  const create = useAction();
  const assign = useAction();
  const canManage = me.permissions.includes("members.manage");
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const close = async () => {
    setRenaming(null);
    setRemoving(null);
    await reload();
  };
  const active = data.members.filter((member) => member.status === "active");
  const unassigned = active.filter((member) => !member.departmentId);
  const used = new Map(
    (data.usage?.activity?.byDepartment ?? []).map((row) => [row.key, row] as const),
  );
  const most = Math.max(1, ...[...used.values()].map((row) => row.costMicros));
  const move = (member: Member, departmentId: string) =>
    assign.run(async () => {
      await api(`/api/members/${member.id}`, { method: "PATCH", body: { departmentId } });
      await reload();
    });
  return (
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className="overflow-hidden pb-0 dense:pb-0">
        <CardHeader className="max-sm:grid-cols-1!">
          <CardTitle>{d.title}</CardTitle>
          <CardDescription>{d.lead}</CardDescription>
          {canManage && (
            // On a narrow screen the form goes under the words, not beside them.
            <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-stretch max-sm:pt-2">
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create.run(async () => {
                    await api("/api/departments", { method: "POST", body: { name } });
                    setName("");
                    await reload();
                  });
                }}
              >
                <Input
                  className="h-8 w-full sm:w-52"
                  placeholder={d.placeholder}
                  aria-label={d.placeholder}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button type="submit" size="sm" disabled={!name.trim() || create.busy}>
                  <PlusIcon />
                  {d.add}
                </Button>
              </form>
            </CardAction>
          )}
        </CardHeader>
        {create.error && (
          <div className="px-3.5">
            <Notice tone="bad">{create.error}</Notice>
          </div>
        )}
        {data.departments.length === 0 ? (
          <Empty>{d.none}</Empty>
        ) : (
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{d.columns.name}</TableHead>
                <TableHead>{d.columns.members}</TableHead>
                <TableHead className="text-right">{d.columns.runs}</TableHead>
                <TableHead className="text-right">{d.columns.cost}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.departments.map((department) => {
                const people = active.filter((member) => member.departmentId === department.id);
                const usage = used.get(department.name);
                return (
                  <TableRow key={department.id}>
                    <TableCell className="font-medium">{department.name}</TableCell>
                    <TableCell className="max-w-[28rem] whitespace-normal">
                      {department.members > 0 ? (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="num w-5 shrink-0 text-muted-foreground">
                            {department.members}
                          </span>
                          {people.map((member) => (
                            <span
                              key={member.id}
                              title={member.email}
                              className="flex items-center gap-1.5 text-[13px]"
                            >
                              <Avatar
                                name={member.name}
                                email={member.email}
                                className="size-5 text-[9px]"
                              />
                              {member.name || member.email}
                              {member.role !== "member" && (
                                <span className="text-xs text-muted-foreground">
                                  {t.roles[member.role]}
                                </span>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <Lead as="span" className="text-[13px] text-muted-foreground">
                          {d.nobody}
                        </Lead>
                      )}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {data.usage ? number(usage?.runs ?? 0) : "–"}
                    </TableCell>
                    <TableCell>
                      {data.usage ? (
                        <span className="flex items-center justify-end gap-2">
                          <span
                            className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
                            aria-hidden="true"
                          >
                            <span
                              className="block h-full rounded-full bg-brand"
                              style={{ width: `${((usage?.costMicros ?? 0) / most) * 100}%` }}
                            />
                          </span>
                          <span className="num min-w-14 text-right">
                            {money(usage?.costMicros ?? 0)}
                          </span>
                        </span>
                      ) : (
                        // What was used could not be loaded: not said to be nothing.
                        <span className="block text-right text-muted-foreground">–</span>
                      )}
                    </TableCell>
                    <TableCell className="w-10 text-right">
                      {canManage && (
                        <MoreMenu
                          label={t.members.manage(department.name)}
                          items={[
                            { label: d.rename, onSelect: () => setRenaming(department) },
                            {
                              label: t.common.delete,
                              destructive: true,
                              onSelect: () => setRemoving(department),
                            },
                          ]}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="grid gap-3">
        <Card className="overflow-hidden pb-0 dense:pb-0">
          <CardHeader>
            <CardTitle>{d.unassignedTitle(unassigned.length)}</CardTitle>
            <CardDescription>{d.unassignedLead}</CardDescription>
          </CardHeader>
          {assign.error && (
            <div className="px-3.5">
              <Notice tone="bad">{assign.error}</Notice>
            </div>
          )}
          {unassigned.length === 0 ? (
            <Empty>{d.unassignedNone}</Empty>
          ) : (
            <ul className="divide-y border-t">
              {unassigned.map((member) => (
                <li key={member.id} className="flex items-center gap-2 px-3.5 py-2">
                  <Avatar name={member.name} email={member.email} className="size-7 text-[11px]" />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-[13px] font-medium">
                      {member.name || member.email}
                    </span>
                    {member.name && (
                      <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                    )}
                  </span>
                  {/* Only for someone this person may change: not themselves, and for an
                      administrator not an owner or another administrator. */}
                  {canManage &&
                    data.departments.length > 0 &&
                    member.id !== me.user.id &&
                    (me.role === "owner" || !["owner", "admin"].includes(member.role)) && (
                      <NativeSelect
                        className="h-8 w-32 text-xs"
                        aria-label={d.assign}
                        value=""
                        disabled={assign.busy}
                        onChange={(event) =>
                          event.target.value && void move(member, event.target.value)
                        }
                      >
                        <option value="">{d.assign}</option>
                        {data.departments.map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {renaming && (
        <RenameDialog department={renaming} onClose={() => setRenaming(null)} onDone={close} />
      )}
      {removing && (
        <RemoveDialog department={removing} onClose={() => setRemoving(null)} onDone={close} />
      )}
    </div>
  );
}

function RenameDialog({
  department,
  onClose,
  onDone,
}: {
  department: Department;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(department.name);
  const action = useAction();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.departments.renameTitle}</DialogTitle>
          <DialogDescription>{t.departments.renameLead}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              await api(`/api/departments/${department.id}`, { method: "PATCH", body: { name } });
              await onDone();
            });
          }}
        >
          <Input
            autoFocus
            aria-label={t.departments.nameLabel}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {action.error && <p className="text-sm text-destructive">{action.error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || name.trim() === department.name || action.busy}
            >
              {t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  department,
  onClose,
  onDone,
}: {
  department: Department;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useI18n();
  const action = useAction();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.departments.deleteTitle(department.name)}</DialogTitle>
          <DialogDescription>{t.departments.deleteBody(department.members)}</DialogDescription>
        </DialogHeader>
        {action.error && <p className="text-sm text-destructive">{action.error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`/api/departments/${department.id}`, { method: "DELETE" });
                await onDone();
              })
            }
          >
            {t.departments.deleteButton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
