import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Dot, Notice, useAction, useLoad } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";

interface Sso {
  saml: {
    entityId: string;
    ssoUrl: string;
    certificates: { fingerprint: string; expires: string }[];
    metadataUrl: string | null;
    enabled: boolean;
    /** Someone has got in through it as it is set now. */
    verified: boolean;
  } | null;
  service: { entityId: string; acsUrl: string };
  /** Setting it up, switching it and making tokens are an owner's to do. */
  owner: boolean;
  scim: {
    baseUrl: string;
    most: number;
    tokens: {
      id: string;
      tail: string;
      createdAt: string;
      lastUsedAt: string | null;
      createdBy: string | null;
    }[];
  };
}

/** A value to carry over to the identity provider's own setup page. */
function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-md bg-foreground/6 px-2 py-1 font-mono text-xs">
          {value}
        </code>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}

/**
 * The organization's own way in (SAML) and what its directory provisions people with
 * (SCIM). For administrators; everyone else's sign-in page only ever shows the one way in.
 */
export function SsoCards({ canManage }: { canManage: boolean }) {
  const { t, ago, date } = useI18n();
  const s = t.sso;
  const { data, error, reload } = useLoad(() => api<Sso>("/api/settings/sso"));
  const action = useAction();
  const asking = useConfirm();
  const [setting, setSetting] = useState(false);
  const [address, setAddress] = useState("");
  const [pasted, setPasted] = useState("");
  const [token, setToken] = useState<string | null>(null);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return null;
  const { saml, service, scim } = data;
  const owner = canManage && data.owner;
  const save = () =>
    action.run(async () => {
      await api("/api/settings/sso/saml", {
        method: "PUT",
        body: pasted.trim() ? { metadataXml: pasted.trim() } : { metadataUrl: address.trim() },
      });
      setSetting(false);
      setAddress("");
      setPasted("");
      await reload();
    });
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{s.samlTitle}</CardTitle>
          {owner && (
            <CardAction>
              {saml ? (
                <MoreMenu
                  label={t.common.more}
                  items={[
                    { label: s.change, onSelect: () => setSetting(true) },
                    {
                      label: s.remove,
                      destructive: true,
                      onSelect: () =>
                        void asking.confirm(s.remove, s.removeConfirm).then((yes) =>
                          yes
                            ? action.run(async () => {
                                await api("/api/settings/sso/saml", { method: "DELETE" });
                                await reload();
                              })
                            : undefined,
                        ),
                    },
                  ]}
                />
              ) : (
                <Button size="sm" variant="outline" onClick={() => setSetting(true)}>
                  {s.setUp}
                </Button>
              )}
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          {action.error && <Notice tone="bad">{action.error}</Notice>}
          {saml ? (
            <>
              <div className="flex items-center justify-between gap-3 rounded-lg border px-2.5 py-1.5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className="truncate font-medium">{host(saml.ssoUrl)}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.certificate(date(saml.certificates[0]?.expires ?? ""))}
                  </span>
                </div>
                <Badge variant={saml.enabled ? "ok" : saml.verified ? "muted" : "warn"}>
                  <Dot />
                  {saml.enabled ? s.on : saml.verified ? s.tried : s.untried}
                </Badge>
              </div>
              {canManage && (saml.enabled || owner) && (
                <div className="flex flex-wrap gap-2">
                  {/* Signs this person in at the provider and makes that account theirs. */}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const { url } = await api<{ url: string }>("/api/settings/sso/saml/try", {
                          method: "POST",
                        });
                        location.assign(url);
                      })
                    }
                  >
                    {saml.enabled ? s.connect : s.tryIt}
                  </Button>
                  {owner && (
                    <Button
                      size="sm"
                      disabled={action.busy || (!saml.enabled && !saml.verified)}
                      title={!saml.enabled && !saml.verified ? s.tryFirst : undefined}
                      onClick={() =>
                        void asking
                          .confirm(
                            saml.enabled ? s.switchOff : s.switchOn,
                            saml.enabled ? s.switchOffConfirm : s.switchOnConfirm,
                          )
                          .then((yes) =>
                            yes
                              ? action.run(async () => {
                                  await api("/api/settings/sso/saml/enabled", {
                                    method: "PUT",
                                    body: { on: !saml.enabled },
                                  });
                                  await reload();
                                })
                              : undefined,
                          )
                      }
                    >
                      {saml.enabled ? s.switchOff : s.switchOn}
                    </Button>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{s.samlNone}</p>
          )}
          <Copyable label={s.entityId} value={service.entityId} />
          <Copyable label={s.acsUrl} value={service.acsUrl} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{s.scimTitle}</CardTitle>
          {owner && scim.tokens.length < scim.most && (
            <CardAction>
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const made = await api<{ token: string }>("/api/settings/sso/scim/tokens", {
                      method: "POST",
                    });
                    setToken(made.token);
                    await reload();
                  })
                }
              >
                <PlusIcon />
                {s.newToken}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          <Copyable label={s.scimUrl} value={scim.baseUrl} />
          {scim.tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">{s.scimNone}</p>
          ) : (
            <ul className="grid gap-1.5">
              {scim.tokens.map((one) => (
                <li
                  key={one.id}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="grid min-w-0">
                    <span className="font-mono text-[13px]">…{one.tail}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {one.lastUsedAt ? s.used(ago(one.lastUsedAt)) : s.unused}
                    </span>
                  </span>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={action.busy}
                      onClick={() =>
                        void asking.confirm(s.revoke, s.revokeConfirm(one.tail)).then((yes) =>
                          yes
                            ? action.run(async () => {
                                await api(`/api/settings/sso/scim/tokens/${one.id}`, {
                                  method: "DELETE",
                                });
                                await reload();
                              })
                            : undefined,
                        )
                      }
                    >
                      {s.revoke}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={setting} onOpenChange={setSetting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{s.samlTitle}</DialogTitle>
            <DialogDescription>{s.setUpLead}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sso-address">{s.metadataUrl}</Label>
              <Input
                id="sso-address"
                placeholder="https://"
                value={address}
                disabled={Boolean(pasted.trim())}
                onChange={(event) => setAddress(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sso-pasted">{s.metadataXml}</Label>
              <Textarea
                id="sso-pasted"
                rows={5}
                className="font-mono text-xs"
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
              />
            </div>
            {action.error && <Notice tone="bad">{action.error}</Notice>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetting(false)}>
              {t.common.cancel}
            </Button>
            <Button
              disabled={action.busy || !(address.trim() || pasted.trim())}
              onClick={() => void save()}
            >
              {t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={token !== null} onOpenChange={(open) => !open && setToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{s.tokenTitle}</DialogTitle>
            <DialogDescription>{s.tokenOnce}</DialogDescription>
          </DialogHeader>
          {token && <Copyable label={s.token} value={token} />}
          <DialogFooter>
            <Button onClick={() => setToken(null)}>{s.done}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {asking.dialog}
    </>
  );
}
