import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ProviderConfig } from "../config.js";

/** Accounts offered on the development sign-in page. */
export const DEV_ACCOUNTS = [
  { email: "owner@muster.test", name: "Olivia Lin" },
  { email: "admin@muster.test", name: "Adam Zhou" },
  { email: "auditor@muster.test", name: "Audrey Shen" },
  { email: "finance@muster.test", name: "Frank He" },
  { email: "member@muster.test", name: "Mia Chen" },
  { email: "stranger@elsewhere.test", name: "Someone outside" },
];

interface PendingCode {
  email: string;
  name: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  expires: number;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * A minimal OpenID Connect provider for development and tests. It signs real ID
 * tokens, so the server's sign-in code runs exactly as it does against Google. It
 * asks for no password: anyone who can reach it can sign in as anyone. It is only
 * mounted when MUSTER_DEV=1.
 */
export async function createDevIdp(provider: ProviderConfig, redirectUri: string): Promise<Hono> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "dev", alg: "RS256", use: "sig" };
  const codes = new Map<string, PendingCode>();
  const issuer = provider.issuer;
  const idp = new Hono();

  idp.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    }),
  );

  idp.get("/jwks", (c) => c.json({ keys: [jwk] }));

  idp.get("/authorize", (c) => {
    const q = c.req.query();
    if (q.client_id !== provider.clientId || q.redirect_uri !== redirectUri || !q.code_challenge) {
      return c.text("invalid authorization request", 400);
    }
    const email = (q.email ?? "").trim().toLowerCase();
    if (!email) {
      const base = new URL(c.req.url).search;
      const link = (address: string) =>
        `${issuer}/authorize${base}&email=${encodeURIComponent(address)}`;
      const items = DEV_ACCOUNTS.map(
        (a) =>
          `<a href="${escapeHtml(link(a.email))}"><b>${escapeHtml(a.name)}</b><span>${escapeHtml(a.email)}</span></a>`,
      ).join("");
      return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Development sign-in</title>
<style>body{font:15px -apple-system,"Segoe UI",sans-serif;background:#f7f7f8;margin:0;display:grid;place-items:center;min-height:100dvh;color:#0d0d0d}
main{background:#fff;border:1px solid #0000001a;border-radius:16px;padding:28px;width:min(92vw,380px)}
h1{font-size:18px;margin:0 0 4px}p{color:#666970;margin:0 0 16px;font-size:13px}
a{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;text-decoration:none;color:inherit}
a:hover{background:#f1f1f3}a span{color:#666970}</style></head><body><main>
<h1>Development sign-in</h1><p>Exists only in development mode and asks for no password. Choose an account:</p>${items}</main></body></html>`);
    }
    const code = randomBytes(24).toString("base64url");
    codes.set(code, {
      email,
      name: DEV_ACCOUNTS.find((a) => a.email === email)?.name ?? email.split("@")[0] ?? email,
      nonce: q.nonce ?? "",
      challenge: q.code_challenge,
      redirectUri: q.redirect_uri,
      expires: Date.now() + 60_000,
    });
    const back = new URL(q.redirect_uri);
    back.searchParams.set("code", code);
    if (q.state) back.searchParams.set("state", q.state);
    back.searchParams.set("iss", issuer);
    return c.redirect(back.toString());
  });

  idp.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const basic = c.req.header("authorization")?.match(/^Basic (.+)$/)?.[1];
    const [basicId, basicSecret] = basic
      ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent)
      : [];
    const clientId = basicId ?? form.client_id;
    const clientSecret = basicSecret ?? form.client_secret;
    if (clientId !== provider.clientId || clientSecret !== provider.clientSecret) {
      return c.json({ error: "invalid_client" }, 401);
    }
    const pending = codes.get(String(form.code));
    codes.delete(String(form.code));
    const verifier = String(form.code_verifier ?? "");
    if (
      !pending ||
      pending.expires < Date.now() ||
      pending.redirectUri !== form.redirect_uri ||
      createHash("sha256").update(verifier).digest("base64url") !== pending.challenge
    ) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    const idToken = await new SignJWT({
      email: pending.email,
      // An address starting with "unverified" exercises the unverified-email path.
      email_verified: !pending.email.startsWith("unverified"),
      name: pending.name,
      nonce: pending.nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "dev" })
      .setIssuer(issuer)
      .setAudience(provider.clientId)
      .setSubject(`dev|${pending.email}`)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return c.json({
      access_token: randomBytes(16).toString("hex"),
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    });
  });

  return idp;
}
