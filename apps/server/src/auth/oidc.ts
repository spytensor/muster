import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import type { Config, ProviderConfig } from "../config.js";
import type { Queryable } from "../db.js";
import type { Identity } from "./admission.js";

const ATTEMPT_MINUTES = 10;
export const LOGIN_COOKIE = "muster_login";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Turns a provider's ID token claims into what admission needs, applying each
 * provider's own rule for when the email address can be believed. Returns null when
 * the token does not identify a usable account.
 */
export function identityFromClaims(
  provider: ProviderConfig,
  claims: Record<string, unknown>,
): Identity | null {
  const text = (key: string) => (typeof claims[key] === "string" ? (claims[key] as string) : "");
  const email = text("email");
  if (!text("sub") || !email) return null;
  const base = {
    provider: provider.id,
    email,
    name: text("name"),
    avatarUrl: text("picture") || null,
  };

  if (provider.id === "microsoft") {
    // The token must come from the configured directory, and the stable account ID there is `oid`.
    if (text("tid").toLowerCase() !== provider.tenant || !text("oid")) return null;
    return {
      ...base,
      subject: text("oid"),
      // Entra's `email` is whatever an administrator or the user typed. It is proven
      // only when the optional `xms_edov` claim says the domain owner verified it.
      emailVerified:
        claims.xms_edov === true || claims.xms_edov === "true" || claims.xms_edov === 1,
      domainProven: claims.xms_edov === true || claims.xms_edov === "true" || claims.xms_edov === 1,
      // The token is from the company's directory (checked above). That alone does not make
      // the account the company's own: a guest invited into the directory carries the same
      // directory in its token. Entra says which it is in `acct` (0 a member, 1 a guest),
      // a claim the directory sends only when the registration asks for it. Without it
      // nothing is assumed: the person is not admitted by the directory, and an operator
      // is told what to set. A guest whose home is elsewhere also carries `idp`.
      fromDirectory: !text("idp") && (claims.acct === 0 || claims.acct === "0"),
    };
  }
  if (provider.id === "google") {
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    const consumer = domain === "gmail.com" || domain === "googlemail.com";
    return {
      ...base,
      subject: text("sub"),
      emailVerified: claims.email_verified === true,
      // A personal Google account can carry a company address forever. Only `hd`
      // says the account is managed by that company's Google Workspace today.
      domainProven: consumer || text("hd").toLowerCase() === domain,
    };
  }
  // The company's own provider, or the development one. A provider that says it checked
  // the address is believed. One the operator declared to be the company's directory is
  // believed for every account, unless it says outright that the address is unchecked.
  const vouched = provider.trustEmail === true && claims.email_verified !== false;
  const believed = claims.email_verified === true || vouched;
  return {
    ...base,
    subject: text("sub"),
    emailVerified: believed,
    // "Verified" from a provider anyone can register at says the person reads that mailbox,
    // not that the company gave them the address. Only the operator's word makes it the
    // company's directory: without it such an account can accept an invitation, but cannot
    // be matched to an existing person, join by a domain rule or become the first owner.
    domainProven: provider.id === "oidc" ? vouched : believed,
    // Its people are members by signing in only when the operator said, in so many words,
    // that everyone in this provider is the company's own. Believing its addresses is a
    // different promise: a provider people can register at may be believed about an
    // address and still must not admit whoever registers.
    fromDirectory: provider.id === "oidc" && provider.directory === true && vouched,
  };
}

/** Sign-in with OpenID Connect providers (authorization code flow with PKCE). */
export class Oidc {
  private readonly configs = new Map<string, Promise<oidc.Configuration>>();

  constructor(
    private readonly config: Config,
    /** Used for provider requests. Tests and the development provider route it in-process. */
    private readonly fetchImpl?: typeof fetch,
  ) {}

  provider(id: string): ProviderConfig | undefined {
    return this.config.providers.find((p) => p.id === id);
  }

  private redirectUri(provider: ProviderConfig): string {
    return `${this.config.publicUrl}/auth/callback/${provider.id}`;
  }

  private discover(provider: ProviderConfig): Promise<oidc.Configuration> {
    let pending = this.configs.get(provider.id);
    if (!pending) {
      const insecure = provider.issuer.startsWith("http://");
      pending = oidc.discovery(
        new URL(provider.issuer),
        provider.clientId,
        provider.clientSecret,
        undefined,
        {
          ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {}),
          ...(this.fetchImpl ? { [oidc.customFetch]: this.fetchImpl } : {}),
        },
      );
      // A failed discovery must not be cached, or one outage would break sign-in until restart.
      pending.catch(() => this.configs.delete(provider.id));
      this.configs.set(provider.id, pending);
    }
    return pending;
  }

  /**
   * Starts a sign-in. Returns the provider URL to send the browser to and a value to
   * put in that browser's cookie: the callback is honoured only from the same browser.
   */
  async begin(db: Queryable, provider: ProviderConfig): Promise<{ url: string; binding: string }> {
    const configuration = await this.discover(provider);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const binding = randomBytes(32).toString("base64url");
    await db.query("delete from login_attempts where expires_at < now()");
    await db.query(
      `insert into login_attempts (state, provider, nonce, code_verifier, binding, expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)`,
      [state, provider.id, nonce, codeVerifier, sha256(binding), String(ATTEMPT_MINUTES)],
    );
    const url = oidc
      .buildAuthorizationUrl(configuration, {
        redirect_uri: this.redirectUri(provider),
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        prompt: "select_account",
      })
      .toString();
    return { url, binding };
  }

  /**
   * Completes a sign-in from the provider's redirect. Each attempt can be used once,
   * and only by the browser that started it. Returns null when the attempt is
   * unknown or expired, the browser is a different one, or the provider's response
   * does not verify.
   */
  async complete(
    db: Queryable,
    provider: ProviderConfig,
    callbackUrl: URL,
    binding: string | undefined,
  ): Promise<Identity | null> {
    const state = callbackUrl.searchParams.get("state");
    if (!state || !binding) return null;
    const attempt = (
      await db.query<{ nonce: string; code_verifier: string }>(
        `delete from login_attempts
          where state = $1 and provider = $2 and binding = $3 and expires_at > now()
          returning nonce, code_verifier`,
        [state, provider.id, sha256(binding)],
      )
    )[0];
    if (!attempt) return null;

    const configuration = await this.discover(provider);
    // The provider redirected to the public URL, whatever host this process sees.
    const current = new URL(`${this.redirectUri(provider)}${callbackUrl.search}`);
    try {
      const tokens = await oidc.authorizationCodeGrant(configuration, current, {
        pkceCodeVerifier: attempt.code_verifier,
        expectedState: state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      return claims ? identityFromClaims(provider, claims as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
