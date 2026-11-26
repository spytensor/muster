import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { newId } from "@muster/protocol";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

/**
 * A person's connection to a service outside Muster: what lets an agent, working for
 * that person and only for them, read their mail, calendar, files and chats there.
 * The organization's operator registers Muster with the service once; each person then
 * gives their own consent on the service's page, and can take it back here at any time.
 */
export interface ConnectorInfo {
  id: "microsoft";
  /** Whether this server is registered with the service, so people can connect at all. */
  available: boolean;
  /** `sends`: what this connection was allowed to send, when it was made. */
  connected: { account: string; since: Date; sends: { mail: boolean; teams: boolean } } | null;
}

/** What is asked of Microsoft for agents: reading only. */
export const MICROSOFT_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Calendars.Read",
  "Files.Read.All",
  "Sites.Read.All",
  "Chat.Read",
];
/**
 * Asked for only where an administrator has let people send what agents draft (drafts.ts).
 * No agent tool uses them. An organization that never switches sending on is never asked
 * for them, and Muster holds no token there that could send.
 */
export const MICROSOFT_SEND_SCOPES = ["Mail.Send", "ChatMessage.Send"];
const ATTEMPT_MINUTES = 10;
const GRAPH = "https://graph.microsoft.com/v1.0";

export class NotConnected extends Error {
  constructor() {
    super(
      "Microsoft 365 is not connected for this person. Tell them to connect it in Settings, under Connections, and then ask again.",
    );
  }
}
export class ConnectorError extends Error {
  constructor(
    message: string,
    /** What the service answered, when it answered at all. A refusal (4xx) means nothing was done. */
    readonly status?: number,
  ) {
    super(message);
  }
}
/** The account that gave consent does not belong to the person who began the connection. */
export class WrongPerson extends Error {
  constructor(readonly account: string) {
    super("the account that gave consent is not the person who began");
  }
}
/** The service says the consent is gone, as opposed to failing to answer. */
const CONSENT_GONE = new Set(["invalid_grant", "interaction_required", "consent_required"]);

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** Seals a text with the server's key: the database alone does not give it up. */
export function sealText(secretKey: string, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sha256(secretKey), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(body)}`;
}
/** Opens what `sealText` sealed. Null when the key is not the one it was sealed with. */
export function openText(secretKey: string, sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", sha256(secretKey), iv as Buffer);
    decipher.setAuthTag(tag as Buffer);
    return Buffer.concat([decipher.update(body as Buffer), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export class Connections {
  private readonly key: Buffer;
  private readonly fetch: typeof fetch;
  /** Renewals under way, by connection: two runs at once renew once, not twice. */
  private readonly renewing = new Map<string, Promise<string>>();
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    /** Requests to the service. Tests supply their own. */
    fetchImpl?: typeof fetch,
  ) {
    this.key = sha256(config.secretKey);
    this.fetch = fetchImpl ?? fetch;
  }

  private get microsoft() {
    // Without a key to seal tokens with, nobody is offered a connection.
    return this.config.secretKey
      ? this.config.providers.find((provider) => provider.id === "microsoft")
      : undefined;
  }
  private get redirect() {
    return `${this.config.publicUrl}/api/app/connectors/microsoft/callback`;
  }
  /** Tokens are kept sealed: the database alone does not give access to anyone's mailbox. */
  private seal(text: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(body)}`;
  }
  private open(sealed: string): string | null {
    try {
      const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv as Buffer);
      decipher.setAuthTag(tag as Buffer);
      return Buffer.concat([decipher.update(body as Buffer), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  async list(user: { orgId: string; userId: string }): Promise<ConnectorInfo[]> {
    const row = (
      await this.db.query<{ account: string; created_at: Date; scopes: string }>(
        "select account, created_at, scopes from connections where org_id = $1 and user_id = $2 and provider = 'microsoft'",
        [user.orgId, user.userId],
      )
    )[0];
    return [
      {
        id: "microsoft",
        available: Boolean(this.microsoft),
        connected: row
          ? {
              account: row.account,
              since: row.created_at,
              // A connection made before sending was asked for has to be made again.
              sends: {
                mail: /(^|[\s/])Mail\.Send(\s|$)/i.test(row.scopes),
                teams: /(^|[\s/])ChatMessage\.Send(\s|$)/i.test(row.scopes),
              },
            }
          : null,
      },
    ];
  }

  /** Begins a connection. Returns the address of the service's consent page for this person. */
  async start(
    user: { orgId: string; userId: string },
    /** Whether this organization lets people send drafts: then the two sending permissions are asked for too. */
    sending = false,
  ): Promise<string | null> {
    const microsoft = this.microsoft;
    if (!microsoft) return null;
    const state = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(32));
    // One attempt a person at a time: starting again gives up the one before.
    await this.db.query(
      "delete from connection_attempts where expires_at < now() or (user_id = $1 and provider = 'microsoft')",
      [user.userId],
    );
    await this.db.query(
      `insert into connection_attempts (state, org_id, user_id, provider, code_verifier, expires_at)
       values ($1, $2, $3, 'microsoft', $4, now() + $5 * interval '1 minute')`,
      [b64url(sha256(state)), user.orgId, user.userId, verifier, ATTEMPT_MINUTES],
    );
    const url = new URL(
      `https://login.microsoftonline.com/${microsoft.tenant}/oauth2/v2.0/authorize`,
    );
    url.search = new URLSearchParams({
      client_id: microsoft.clientId,
      response_type: "code",
      response_mode: "query",
      redirect_uri: this.redirect,
      scope: [...MICROSOFT_SCOPES, ...(sending ? MICROSOFT_SEND_SCOPES : [])].join(" "),
      state,
      code_challenge: b64url(sha256(verifier)),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  private async token(form: Record<string, string>) {
    const microsoft = this.microsoft;
    if (!microsoft) throw new ConnectorError("Microsoft 365 is not set up on this server.");
    const response = await this.fetch(
      `https://login.microsoftonline.com/${microsoft.tenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: microsoft.clientId,
          client_secret: microsoft.clientSecret,
          ...form,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== "string")
      throw new ConnectorError(
        typeof body.error === "string" ? body.error : `token endpoint answered ${response.status}`,
      );
    return {
      access: body.access_token,
      refresh: typeof body.refresh_token === "string" ? body.refresh_token : null,
      seconds: Number(body.expires_in) || 3600,
      scope: typeof body.scope === "string" ? body.scope : "",
    };
  }

  /**
   * Completes a connection from the service's answer. The state is what ties the answer
   * to the person who began: it was made for them, lives ten minutes and works once.
   */
  async finish(
    state: string,
    code: string,
    /** The person signed in to Muster in the browser the answer arrived in, if anyone is. */
    signedIn?: string,
  ): Promise<{ orgId: string; userId: string; email: string; account: string } | null> {
    const attempt = (
      await this.db.query<{ org_id: string; user_id: string; code_verifier: string }>(
        "delete from connection_attempts where state = $1 and expires_at > now() returning org_id, user_id, code_verifier",
        [b64url(sha256(state))],
      )
    )[0];
    if (!attempt) return null;
    const tokens = await this.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirect,
      code_verifier: attempt.code_verifier,
    });
    if (!tokens.refresh) throw new ConnectorError("the service gave no way to stay connected");
    const me = (await this.graphWith(tokens.access, "/me?$select=userPrincipalName,mail")) as {
      mail?: string;
      userPrincipalName?: string;
    };
    const account = String(me.mail || me.userPrincipalName || "Microsoft account").slice(0, 200);
    // The link to the consent page can be handed to someone else, who would then give the
    // person who began it their own mailbox. So the answer counts only when it arrives in
    // a browser signed in to Muster as that person, or the account that consented is theirs.
    const email =
      (
        await this.db.query<{ email: string }>("select email from users where id = $1", [
          attempt.user_id,
        ])
      )[0]?.email ?? "";
    const theirs = [me.mail, me.userPrincipalName].some(
      (address) => address && address.toLowerCase() === email.toLowerCase(),
    );
    if (signedIn !== attempt.user_id && !theirs) throw new WrongPerson(account);
    await this.db.query(
      `insert into connections (id, org_id, user_id, provider, account, scopes, access_token, refresh_token, expires_at)
       values ($1, $2, $3, 'microsoft', $4, $5, $6, $7, now() + $8 * interval '1 second')
       on conflict (user_id, provider) do update set account = excluded.account, scopes = excluded.scopes,
         access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, created_at = now()`,
      [
        newId(),
        attempt.org_id,
        attempt.user_id,
        account,
        tokens.scope,
        this.seal(tokens.access),
        this.seal(tokens.refresh),
        tokens.seconds,
      ],
    );
    return { orgId: attempt.org_id, userId: attempt.user_id, email, account };
  }

  async remove(user: { orgId: string; userId: string }): Promise<string | null> {
    const removed = await this.db.query<{ account: string }>(
      "delete from connections where org_id = $1 and user_id = $2 and provider = 'microsoft' returning account",
      [user.orgId, user.userId],
    );
    return removed[0]?.account ?? null;
  }

  /** Everyone in the organization who has a connection, for its administrators: who, to what account, since when. Never a token. */
  async all(orgId: string) {
    return this.db.query<{
      userId: string;
      name: string;
      email: string;
      provider: string;
      account: string;
      since: Date;
    }>(
      `select c.user_id as "userId", u.name, u.email, c.provider, c.account, c.created_at as since
         from connections c join users u on u.id = c.user_id
        where c.org_id = $1 order by c.created_at desc`,
      [orgId],
    );
  }
  /** Ends every connection a person has: when they leave or are suspended, what they consented to goes with them. */
  async removeAll(userId: string): Promise<{ orgId: string; account: string; email: string }[]> {
    await this.db.query("delete from connection_attempts where user_id = $1", [userId]);
    return this.db.query<{ orgId: string; account: string; email: string }>(
      `delete from connections c using users u where c.user_id = $1 and u.id = c.user_id
       returning c.org_id as "orgId", c.account, u.email`,
      [userId],
    );
  }

  /** A token that works now for this person, renewed when it has run out. Throws NotConnected when they have none. */
  private async accessFor(user: { orgId: string; userId: string }): Promise<string> {
    const row = (
      await this.db.query<{
        id: string;
        access_token: string;
        refresh_token: string;
        fresh: boolean;
      }>(
        `select id, access_token, refresh_token, expires_at > now() + interval '2 minutes' as fresh
           from connections where org_id = $1 and user_id = $2 and provider = 'microsoft'`,
        [user.orgId, user.userId],
      )
    )[0];
    if (!row) throw new NotConnected();
    const access = this.open(row.access_token);
    if (row.fresh && access) return access;
    const refresh = this.open(row.refresh_token);
    if (!refresh) {
      // Sealed with a key this server no longer has: it cannot be used, so it is not kept.
      await this.db.query("delete from connections where id = $1", [row.id]);
      throw new NotConnected();
    }
    const under = this.renewing.get(row.id);
    if (under) return under;
    const renewal = this.renew(row.id, refresh).finally(() => this.renewing.delete(row.id));
    this.renewing.set(row.id, renewal);
    return renewal;
  }
  private async renew(id: string, refresh: string): Promise<string> {
    let tokens: Awaited<ReturnType<Connections["token"]>>;
    try {
      tokens = await this.token({ grant_type: "refresh_token", refresh_token: refresh });
    } catch (error) {
      // Only the service saying the consent is gone ends the connection. When it merely
      // did not answer, the connection stays and the next call tries again.
      if (error instanceof ConnectorError && CONSENT_GONE.has(error.message)) {
        await this.db.query("delete from connections where id = $1", [id]);
        throw new NotConnected();
      }
      throw new ConnectorError("Microsoft 365 could not be reached just now. Try again shortly.");
    }
    await this.db.query(
      "update connections set access_token = $2, refresh_token = $3, expires_at = now() + $4 * interval '1 second' where id = $1",
      [id, this.seal(tokens.access), this.seal(tokens.refresh ?? refresh), tokens.seconds],
    );
    return tokens.access;
  }

  private async graphWith(access: string, path: string): Promise<unknown> {
    const response = await this.fetch(`${GRAPH}${path}`, {
      headers: { authorization: `Bearer ${access}`, prefer: 'outlook.body-content-type="text"' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new ConnectorError(
        response.status === 403
          ? "Microsoft 365 did not allow that. The organization may not have granted Muster that permission."
          : response.status === 404
            ? "Microsoft 365 has nothing at that id."
            : `Microsoft 365 answered ${response.status}${body.error?.message ? `: ${body.error.message.slice(0, 200)}` : ""}`,
        response.status,
      );
    }
    return response.json();
  }
  /** Asks Microsoft Graph something as this person. */
  async graph(user: { orgId: string; userId: string }, path: string): Promise<unknown> {
    return this.graphWith(await this.accessFor(user), path);
  }
  /**
   * Sends something as this person: a mail, a message in a chat. Only the routes a person
   * presses Send on call this (drafts.ts); no agent tool does.
   */
  async post(user: { orgId: string; userId: string }, path: string, body: unknown): Promise<void> {
    // No token, no request: said as a refusal, so nobody is told it may have gone.
    const access = await this.accessFor(user).catch((error) => {
      throw error instanceof ConnectorError && error.status === undefined
        ? new ConnectorError(error.message, 424)
        : error;
    });
    const response = await this.fetch(`${GRAPH}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return;
    const answer = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ConnectorError(
      response.status === 403
        ? "Microsoft 365 did not allow that. You may not be allowed to post there, or the organization has not granted Muster permission to send."
        : response.status === 404
          ? "Microsoft 365 has nothing at that id."
          : `Microsoft 365 answered ${response.status}${answer.error?.message ? `: ${answer.error.message.slice(0, 200)}` : ""}`,
      response.status,
    );
  }
  /** The bytes of a file in the person's OneDrive or a site they can see, up to a limit. */
  async download(
    user: { orgId: string; userId: string },
    path: string,
    most: number,
  ): Promise<Uint8Array> {
    const response = await this.fetch(`${GRAPH}${path}`, {
      headers: { authorization: `Bearer ${await this.accessFor(user)}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ConnectorError(`Microsoft 365 answered ${response.status}`);
    // Read as it arrives and stop at the limit: the size a service states is not relied on.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > most) throw new ConnectorError("That file is too large to read here.");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return bytes;
  }
}
