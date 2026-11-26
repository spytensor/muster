import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";
import {
  Dot,
  Empty,
  Loading,
  Notice,
  Person,
  RoleBadge,
  useAction,
  useLoad,
} from "@/components/shared";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { useI18n } from "@/i18n";
import { MemberDetail } from "./MemberDetail";
import { api, type Department, type Me, type Member, type Role } from "@/lib/api";
import { address } from "@/lib/utils";

export const ROLE_ORDER: Role[] = ["owner", "admin", "auditor", "billing", "member"];

/** Roles the signed-in person may hand out. It mirrors the server's rule, which is the one enforced. */
export const grantable = (role: Role): Role[] =>
  role === "owner" ? ROLE_ORDER : role === "admin" ? ["auditor", "billing", "member"] : [];

type Pending = {
  kind: "edit" | "suspend" | "reactivate" | "remove" | "restore";
  member: Member;
} | null;
const who = (member: Member) =>
  member.name && address(member.email)
    ? `${member.name} (${member.email})`
    : member.name || member.email;

interface Invitation {
  id: string;
  email: string;
  role: Role;
  departmentName: string | null;
  invitedBy: string | null;
  expiresAt: string;
  state: "pending" | "accepted" | "revoked" | "expired";
}

/**
 * Invitations that would still let someone in. Nobody is invited from this console any
 * more; whatever is still pending is shown here so it can be seen and withdrawn. Nothing
 * is shown when there is none.
 */
function PendingInvitations({ canManage }: { canManage: boolean }) {
  const { t, date } = useI18n();
  const i = t.invitations;
  const { data, reload } = useLoad(() => api<Invitation[]>("/api/invitations"));
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const pending = (data ?? []).filter((invitation) => invitation.state === "pending");
  if (pending.length === 0) return null;
  const withdraw = async (invitation: Invitation) => {
    if (!(await confirm(i.withdraw, i.withdrawConfirm(invitation.email)))) return;
    await action.run(async () => {
      await api(`/api/invitations/${invitation.id}`, { method: "DELETE" });
      await reload();
    });
  };
  return (
    <Card className="mt-3 overflow-hidden pb-0 dense:pb-0">
      <CardHeader>
        <CardTitle>{i.pendingTitle(pending.length)}</CardTitle>
        <CardDescription>{i.pendingLead}</CardDescription>
      </CardHeader>
      {action.error && (
        <div className="px-3.5">
          <Notice tone="bad">{action.error}</Notice>
        </div>
      )}
      <Table pinLast>
        <TableHeader>
          <TableRow>
            <TableHead>{i.columns.email}</TableHead>
            <TableHead>{i.columns.role}</TableHead>
            <TableHead>{i.columns.department}</TableHead>
            <TableHead>{i.columns.by}</TableHead>
            <TableHead>{i.expires}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {pending.map((invitation) => (
            <TableRow key={invitation.id}>
              <TableCell className="font-mono text-[13px]">{invitation.email}</TableCell>
              <TableCell>{t.roles[invitation.role]}</TableCell>
              <TableCell>{invitation.departmentName ?? t.common.unassigned}</TableCell>
              <TableCell className="text-muted-foreground">{invitation.invitedBy ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{date(invitation.expiresAt)}</TableCell>
              <TableCell className="text-right">
                {canManage && (
                  <MoreMenu
                    label={t.members.manage(invitation.email)}
                    items={[
                      {
                        label: i.withdraw,
                        destructive: true,
                        onSelect: () => void withdraw(invitation),
                      },
                    ]}
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {dialog}
    </Card>
  );
}

export function MembersPage({ me }: { me: Me }) {
  const { t, ago, date } = useI18n();
  const members = useLoad(() => api<Member[]>("/api/members"));
  const departments = useLoad(() => api<Department[]>("/api/departments"));
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<Role | "all">("all");
  const [status, setStatus] = useState("all");
  const [pending, setPending] = useState<Pending>(null);
  const [open, setOpen] = useState<string | null>(null);
  const canManage = me.permissions.includes("members.manage");
  const mine = grantable(me.role);

  if (members.error) return <Notice tone="bad">{members.error}</Notice>;
  if (!members.data || !departments.data) return <Loading />;
  const needle = query.trim().toLowerCase();
  const rows = members.data.filter(
    (m) =>
      (!needle ||
        `${m.name} ${address(m.email)} ${m.departmentName ?? ""}`.toLowerCase().includes(needle)) &&
      (role === "all" || m.role === role) &&
      // Someone removed is no longer a member: they are listed only where asked for.
      (status === "all" ? m.status !== "removed" : m.status === status),
  );
  const current = members.data.filter((m) => m.status !== "removed");
  const removed = members.data.length - current.length;
  // The last removed person was let back in: the filter that showed them is gone.
  if (status === "removed" && removed === 0) setStatus("all");
  const suspended = current.filter((m) => m.status === "suspended").length;
  const done = async () => {
    setPending(null);
    await members.reload();
  };

  return (
    <>
      <Card className="overflow-hidden pb-0 dense:pb-0">
        <CardHeader>
          <CardTitle>{t.members.title}</CardTitle>
          <CardDescription>{t.members.summary(current.length, suspended)}</CardDescription>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-3 px-3.5">
          <Input
            className="sm:w-72"
            placeholder={t.members.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <NativeSelect
            className="w-44"
            aria-label={t.members.filterRole}
            value={role}
            onChange={(event) => setRole(event.target.value as Role | "all")}
          >
            <option value="all">{t.members.allRoles}</option>
            {ROLE_ORDER.map((r) => (
              <option key={r} value={r}>
                {t.roles[r]}
              </option>
            ))}
          </NativeSelect>
          <Tabs value={status} onValueChange={setStatus}>
            <TabsList>
              <TabsTrigger value="all">{t.common.all}</TabsTrigger>
              <TabsTrigger value="active">{t.status.active}</TabsTrigger>
              <TabsTrigger value="suspended">{t.status.suspended}</TabsTrigger>
              {removed > 0 && <TabsTrigger value="removed">{t.status.removed}</TabsTrigger>}
            </TabsList>
          </Tabs>
        </div>
        {rows.length === 0 ? (
          <Empty>{t.members.none}</Empty>
        ) : (
          <Table pinLast>
            <TableHeader>
              <TableRow>
                <TableHead>{t.members.columns.member}</TableHead>
                <TableHead>{t.members.columns.role}</TableHead>
                <TableHead>{t.members.columns.department}</TableHead>
                <TableHead>{t.members.columns.status}</TableHead>
                <TableHead>{t.members.columns.joined}</TableHead>
                <TableHead>{t.members.columns.lastLogin}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((member) => {
                const self = member.id === me.user.id;
                const manageable = canManage && !self && mine.includes(member.role);
                return (
                  <TableRow
                    key={member.id}
                    className="cursor-pointer"
                    onClick={() => setOpen(member.id)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Person name={member.name} email={member.email} />
                        {self && <Badge variant="muted">{t.common.you}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <RoleBadge role={member.role} />
                    </TableCell>
                    <TableCell className={member.departmentName ? "" : "text-muted-foreground"}>
                      {member.departmentName ?? t.common.unassigned}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          member.status === "active"
                            ? "ok"
                            : member.status === "suspended"
                              ? "destructive"
                              : "muted"
                        }
                      >
                        <Dot />
                        {t.status[member.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {date(member.joinedAt)} · {t.joinedVia[member.joinedVia]}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {ago(member.lastLoginAt)}
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      {manageable && member.status === "removed" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPending({ kind: "restore", member })}
                        >
                          {t.members.restore}
                        </Button>
                      )}
                      {manageable && member.status !== "removed" && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t.members.manage(member.name || member.email)}
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setPending({ kind: "edit", member })}>
                              {t.members.edit}
                            </DropdownMenuItem>
                            {member.status === "active" ? (
                              <DropdownMenuItem
                                onSelect={() => setPending({ kind: "suspend", member })}
                              >
                                {t.members.suspend}
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onSelect={() => setPending({ kind: "reactivate", member })}
                              >
                                {t.members.reactivate}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setPending({ kind: "remove", member })}
                            >
                              {t.members.removeFromOrg}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.members.rolesTitle}</CardTitle>
          <CardDescription>{t.members.rolesLead}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {ROLE_ORDER.map((r) => (
            <div key={r} className="grid content-start gap-2 rounded-lg border px-2.5 py-1.5">
              <RoleBadge role={r} />
              <p className="text-sm text-muted-foreground">{t.roleSummary[r]}</p>
            </div>
          ))}
        </CardContent>
      </Card>
      <PendingInvitations canManage={canManage} />

      {open && (
        <MemberDetail
          me={me}
          id={open}
          onClose={() => setOpen(null)}
          onAct={(kind, member) => {
            setOpen(null);
            setPending({ kind, member });
          }}
        />
      )}
      {pending?.kind === "edit" && (
        <EditDialog
          member={pending.member}
          roles={mine}
          departments={departments.data}
          onClose={() => setPending(null)}
          onDone={done}
        />
      )}
      {pending && pending.kind !== "edit" && (
        <ConfirmDialog
          kind={pending.kind}
          member={pending.member}
          onClose={() => setPending(null)}
          onDone={done}
        />
      )}
    </>
  );
}

function DepartmentSelect({
  value,
  onChange,
  departments,
}: {
  value: string;
  onChange: (value: string) => void;
  departments: Department[];
}) {
  const { t } = useI18n();
  return (
    <NativeSelect id="department" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t.common.unassigned}</option>
      {departments.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </NativeSelect>
  );
}

function RoleSelect({
  value,
  onChange,
  roles,
}: {
  value: Role;
  onChange: (value: Role) => void;
  roles: Role[];
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5">
      <NativeSelect
        id="role"
        value={value}
        onChange={(event) => onChange(event.target.value as Role)}
      >
        {roles.map((r) => (
          <option key={r} value={r}>
            {t.roles[r]}
          </option>
        ))}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">{t.roleSummary[value]}</p>
    </div>
  );
}

function EditDialog({
  member,
  roles,
  departments,
  onClose,
  onDone,
}: {
  member: Member;
  roles: Role[];
  departments: Department[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [role, setRole] = useState<Role>(member.role);
  const [department, setDepartment] = useState(member.departmentId ?? "");
  const action = useAction();
  const changed = role !== member.role || department !== (member.departmentId ?? "");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.members.editTitle}</DialogTitle>
          <DialogDescription>{who(member)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="role">{t.members.role}</Label>
            <RoleSelect value={role} onChange={setRole} roles={roles} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="department">{t.members.department}</Label>
            <DepartmentSelect
              value={department}
              onChange={setDepartment}
              departments={departments}
            />
          </div>
          {action.error && <p className="text-sm text-destructive">{action.error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            disabled={!changed || action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`/api/members/${member.id}`, {
                  method: "PATCH",
                  body: {
                    ...(role !== member.role ? { role } : {}),
                    ...(department !== (member.departmentId ?? "")
                      ? { departmentId: department || null }
                      : {}),
                  },
                });
                await onDone();
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

function ConfirmDialog({
  kind,
  member,
  onClose,
  onDone,
}: {
  kind: "suspend" | "reactivate" | "remove" | "restore";
  member: Member;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useI18n();
  const action = useAction();
  const copy = t.members.confirm[kind];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{who(member)}</span>
            <br />
            {copy.body}
          </DialogDescription>
        </DialogHeader>
        {action.error && <p className="text-sm text-destructive">{action.error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            variant={kind === "reactivate" || kind === "restore" ? "default" : "destructive"}
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                if (kind === "remove") await api(`/api/members/${member.id}`, { method: "DELETE" });
                else
                  await api(`/api/members/${member.id}`, {
                    method: "PATCH",
                    body: { status: kind === "suspend" ? "suspended" : "active" },
                  });
                await onDone();
              })
            }
          >
            {copy.button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
