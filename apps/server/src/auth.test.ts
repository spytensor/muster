import { beforeEach, describe, expect, it } from "vitest";
import { admit, type Identity } from "./auth/admission.js";
import { identityFromClaims } from "./auth/oidc.js";
import { loadConfig, type ProviderConfig } from "./config.js";
import { type Harness, harness } from "./test-support.js";

const google: ProviderConfig = {
  id: "google",
  label: "Google",
  issuer: "https://accounts.google.com",
  clientId: "c",
  clientSecret: "s",
};
const microsoft: ProviderConfig = {
  id: "microsoft",
  label: "Microsoft",
  issuer: "https://login.microsoftonline.com/t1/v2.0",
  clientId: "c",
  clientSecret: "s",
  tenant: "t1",
};

describe("what each provider's token proves", () => {
  it("takes a Microsoft account for the company's own only when the directory says it is a member", () => {
    const claims = { sub: "s", oid: "o-1", tid: "t1", email: "ada@corp.example", xms_edov: true };
    const from = (extra: Record<string, unknown>) =>
      identityFromClaims(microsoft, { ...claims, ...extra })?.fromDirectory;
    // The directory was asked to say, and says a member.
    expect(from({ acct: 0 })).toBe(true);
    // A guest, by the same claim or by a home elsewhere.
    expect(from({ acct: 1 })).toBe(false);
    expect(from({ acct: 0, idp: "https://sts.windows.net/other/" })).toBe(false);
    // The directory was not asked to say: nothing is assumed.
    expect(from({})).toBe(false);
  });

  it("makes members of a company provider's people only on the operator's word that it is the directory", () => {
    const base = {
      id: "oidc" as const,
      label: "Corp",
      issuer: "https://id.corp.example",
      clientId: "c",
      clientSecret: "s",
    };
    const claims = { sub: "1", email: "ada@corp.example", email_verified: true };
    expect(identityFromClaims({ ...base, trustEmail: true }, claims)?.fromDirectory).toBe(false);
    expect(
      identityFromClaims({ ...base, trustEmail: true, directory: true }, claims)?.fromDirectory,
    ).toBe(true);
    // Saying it is the directory without vouching for its addresses is not enough.
    expect(identityFromClaims({ ...base, directory: true }, claims)?.fromDirectory).toBe(false);
  });

  it("believes a Google Workspace address only when the account is managed by that domain", () => {
    const managed = identityFromClaims(google, {
      sub: "1",
      email: "ada@corp.example",
      email_verified: true,
      hd: "corp.example",
    });
    expect(managed).toMatchObject({ subject: "1", emailVerified: true, domainProven: true });
    // A personal Google account registered with a company address: verified once, not managed.
    const personal = identityFromClaims(google, {
      sub: "2",
      email: "ada@corp.example",
      email_verified: true,
    });
    expect(personal).toMatchObject({ emailVerified: true, domainProven: false });
    const otherWorkspace = identityFromClaims(google, {
      sub: "3",
      email: "ada@corp.example",
      email_verified: true,
      hd: "evil.example",
    });
    expect(otherWorkspace?.domainProven).toBe(false);
    expect(
      identityFromClaims(google, { sub: "4", email: "ada@gmail.com", email_verified: true })
        ?.domainProven,
    ).toBe(true);
    expect(
      identityFromClaims(google, {
        sub: "5",
        email: "ada@corp.example",
        email_verified: false,
        hd: "corp.example",
      })?.emailVerified,
    ).toBe(false);
  });

  it("accepts a Microsoft token only from the configured directory and only with a verified domain", () => {
    const ok = identityFromClaims(microsoft, {
      sub: "pairwise",
      oid: "o-1",
      tid: "T1",
      email: "ada@corp.example",
      xms_edov: true,
    });
    expect(ok).toMatchObject({ subject: "o-1", emailVerified: true, domainProven: true });
    // Entra's email claim is whatever was typed in; without the domain-owner flag it proves nothing.
    expect(
      identityFromClaims(microsoft, {
        sub: "p",
        oid: "o-2",
        tid: "t1",
        email: "owner@victim.example",
      }),
    ).toMatchObject({ emailVerified: false });
    expect(
      identityFromClaims(microsoft, {
        sub: "p",
        oid: "o-3",
        tid: "other",
        email: "a@corp.example",
        xms_edov: true,
      }),
    ).toBeNull();
    expect(
      identityFromClaims(microsoft, {
        sub: "p",
        tid: "t1",
        email: "a@corp.example",
        xms_edov: true,
      }),
    ).toBeNull();
  });

  it("believes a company's own provider when it checked the address, or when the operator vouches for it", () => {
    const own = {
      id: "oidc",
      label: "SSO",
      issuer: "https://sso",
      clientId: "c",
      clientSecret: "s",
    } as const;
    const claims = { sub: "u1", email: "na@example.com", name: "Na" };
    // Verified by a provider anyone might register at: enough to accept an invitation,
    // not enough to be matched to an existing person, join by domain or be the first owner.
    expect(identityFromClaims(own, { ...claims, email_verified: true })).toMatchObject({
      provider: "oidc",
      subject: "u1",
      emailVerified: true,
      domainProven: false,
    });
    // Many company directories never say whether they checked: without the operator's word that is a no.
    expect(identityFromClaims(own, claims)).toMatchObject({ emailVerified: false });
    const vouched = { ...own, trustEmail: true };
    expect(identityFromClaims(vouched, claims)).toMatchObject({
      emailVerified: true,
      domainProven: true,
    });
    // Even then, an address the provider itself marks unchecked is not believed.
    expect(identityFromClaims(vouched, { ...claims, email_verified: false })).toMatchObject({
      emailVerified: false,
    });
  });

  it("rejects a token with no subject or no email", () => {
    expect(identityFromClaims(google, { sub: "1" })).toBeNull();
    expect(identityFromClaims(google, { email: "a@b.example", email_verified: true })).toBeNull();
  });
});

describe("matching a sign-in to an existing person", () => {
  let h: Harness;
  const who = (over: Partial<Identity>): Identity => ({
    provider: "google",
    subject: "g-1",
    email: "owner@acme.test",
    emailVerified: true,
    domainProven: true,
    name: "",
    avatarUrl: null,
    ...over,
  });
  const enter = (identity: Identity) => h.db.tx((tx) => admit(tx, h.config, identity, null));

  beforeEach(async () => {
    h = await harness();
    expect(await enter(who({}))).toMatchObject({ ok: true, role: "owner" });
  });

  it("recognises a returning person by the provider's account, even if their address changed", async () => {
    expect(await enter(who({ email: "renamed@acme.test" }))).toMatchObject({
      ok: true,
      role: "owner",
    });
  });

  it("refuses a different account at the same provider that now holds the address", async () => {
    // The mailbox was reassigned or recreated: same address, new account.
    expect(await enter(who({ subject: "g-2" }))).toEqual({
      ok: false,
      reason: "identity_conflict",
    });
    expect(await h.db.query("select 1 from identities")).toHaveLength(1);
    const denied = await h.db.query(
      "select detail from admin_events where action = 'auth.login_denied'",
    );
    expect(denied).toMatchObject([{ detail: { reason: "identity_conflict" } }]);
  });

  it("links a second provider only when that provider proves the domain", async () => {
    expect(
      await enter(who({ provider: "microsoft", subject: "m-1", domainProven: false })),
    ).toEqual({ ok: false, reason: "identity_conflict" });
    expect(
      await enter(who({ provider: "microsoft", subject: "m-1", domainProven: true })),
    ).toMatchObject({ ok: true, role: "owner" });
    expect(await h.db.query("select 1 from identities")).toHaveLength(2);
  });

  it("makes a member of anyone in the company's own directory, and keeps out a guest and someone removed", async () => {
    const staff = who({
      provider: "microsoft",
      subject: "m-staff",
      email: "staff@acme.test",
      domainProven: false,
      fromDirectory: true,
    });
    // No invitation and no domain rule: being in the directory is what admits them.
    const first = await enter(staff);
    expect(first).toMatchObject({ ok: true, role: "member" });
    expect(await h.db.query("select joined_via from memberships where role = 'member'")).toEqual([
      { joined_via: "directory" },
    ]);
    // A guest of the directory, or an account from anywhere else, is not the company's own.
    expect(
      await enter(
        who({
          provider: "microsoft",
          subject: "m-guest",
          email: "guest@other.test",
          domainProven: false,
        }),
      ),
    ).toEqual({ ok: false, reason: "not_member" });
    // An administrator removed them: the directory does not let them straight back in.
    await h.db.query("update memberships set status = 'removed' where role = 'member'");
    expect(await enter(staff)).toEqual({ ok: false, reason: "removed" });
    await h.db.query("update memberships set status = 'active' where role = 'member'");
    expect(await enter(staff)).toMatchObject({ ok: true, role: "member" });
  });

  it("lets a domain rule admit only accounts the domain owner manages", async () => {
    const { org_id } = (
      await h.db.query<{ org_id: string }>("select org_id from memberships")
    )[0] as { org_id: string };
    await h.db.query(
      "insert into org_domains (org_id, domain, auto_join) values ($1, 'acme.test', true)",
      [org_id],
    );
    expect(
      await enter(who({ subject: "g-9", email: "leaver@acme.test", domainProven: false })),
    ).toEqual({ ok: false, reason: "not_member" });
    expect(
      await enter(who({ subject: "g-10", email: "staff@acme.test", domainProven: true })),
    ).toMatchObject({ ok: true, role: "member" });
  });

  it("lets only an account whose domain is proven create the organization", async () => {
    const fresh = await harness();
    const first = (identity: Identity) =>
      fresh.db.tx((tx) => admit(tx, fresh.config, identity, null));
    expect(await first(who({ domainProven: false }))).toEqual({ ok: false, reason: "not_member" });
    expect(await fresh.db.query("select 1 from organizations")).toHaveLength(0);
    expect(await first(who({}))).toMatchObject({ ok: true, role: "owner" });
  });

  it("refuses, and leaves no trace of, a join the person's existing membership makes impossible", async () => {
    // Someone removed from this organization is invited by a second one. A person
    // belongs to one organization, so the join cannot happen and nothing may say it did.
    const { org_id: home } = (
      await h.db.query<{ org_id: string }>("select org_id from memberships")
    )[0] as { org_id: string };
    expect(await enter(who({ subject: "g-20", email: "sam@acme.test" }))).toMatchObject({
      ok: false,
    });
    await h.db.query(
      "insert into users (id, email) values ('0198c3a0-0000-7000-8000-00000000000a', 'sam@acme.test')",
    );
    await h.db.query(
      "insert into memberships (org_id, user_id, role, status, joined_via) values ($1, '0198c3a0-0000-7000-8000-00000000000a', 'member', 'removed', 'invitation')",
      [home],
    );
    await h.db.query(
      "insert into organizations (id, name) values ('0198c3a0-0000-7000-8000-0000000000b0', 'Beta')",
    );
    const owner = (
      await h.db.query<{ user_id: string }>("select user_id from memberships where role = 'owner'")
    )[0]?.user_id;
    await h.db.query(
      "insert into invitations (id, org_id, email, role, invited_by, expires_at) values ('0198c3a0-0000-7000-8000-0000000000c0', '0198c3a0-0000-7000-8000-0000000000b0', 'sam@acme.test', 'member', $1, now() + interval '1 day')",
      [owner],
    );
    await expect(enter(who({ subject: "g-21", email: "sam@acme.test" }))).rejects.toThrow();
    expect(
      await h.db.query("select 1 from invitations where accepted_at is not null"),
    ).toHaveLength(0);
    expect(
      await h.db.query(
        "select 1 from admin_events where org_id = '0198c3a0-0000-7000-8000-0000000000b0'",
      ),
    ).toHaveLength(0);
    expect(
      await h.db.query(
        "select status from memberships where user_id = '0198c3a0-0000-7000-8000-00000000000a'",
      ),
    ).toEqual([{ status: "removed" }]);
  });

  it("refuses addresses that are not plain ASCII", async () => {
    // U+212A (Kelvin sign) lower-cases to "k": a different address that would fold onto a real one.
    expect(await enter(who({ subject: "g-11", email: "Kate@acme.test" }))).toEqual({
      ok: false,
      reason: "email_unverified",
    });
  });
});

describe("configuration", () => {
  const base = {
    MUSTER_PUBLIC_URL: "https://muster.example.com",
    DATABASE_URL: "postgres://x",
    MUSTER_BOOTSTRAP_OWNER_EMAIL: " Owner@Example.com ",
    MUSTER_GOOGLE_CLIENT_ID: "id",
    MUSTER_GOOGLE_CLIENT_SECRET: "secret",
  };

  it("reads how long to wait for the model, and refuses a wait that means nothing", () => {
    const model = {
      ...base,
      MUSTER_MODEL_API: "openai",
      MUSTER_MODEL_ID: "m",
      MUSTER_MODEL_API_KEY: "k",
    };
    expect(loadConfig(model).model).toMatchObject({ firstWordSeconds: 180, silenceSeconds: 90 });
    expect(
      loadConfig({
        ...model,
        MUSTER_MODEL_FIRST_WORD_SECONDS: "30",
        MUSTER_MODEL_SILENCE_SECONDS: "20",
      }).model,
    ).toMatchObject({ firstWordSeconds: 30, silenceSeconds: 20 });
    for (const bad of ["0", "2", "1000", "soon", "1.5", "0x10", "1e2"])
      expect(() => loadConfig({ ...model, MUSTER_MODEL_FIRST_WORD_SECONDS: bad })).toThrow(
        /MUSTER_MODEL_FIRST_WORD_SECONDS/,
      );
  });

  it("loads a production configuration", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      dev: false,
      bootstrapOwnerEmail: "owner@example.com",
      sessionDays: 7,
      trustProxy: false,
    });
    expect(config.providers.map((p) => p.id)).toEqual(["google"]);
  });

  it("takes a company's own OpenID Connect provider, and refuses one that is half set", () => {
    const own = {
      ...base,
      MUSTER_GOOGLE_CLIENT_ID: "",
      MUSTER_GOOGLE_CLIENT_SECRET: "",
      MUSTER_OIDC_ISSUER: "https://sso.example.com/realms/staff/",
      MUSTER_OIDC_CLIENT_ID: "muster",
      MUSTER_OIDC_CLIENT_SECRET: "secret",
      MUSTER_OIDC_LABEL: "Example SSO",
    };
    expect(loadConfig(own).providers).toEqual([
      {
        id: "oidc",
        label: "Example SSO",
        issuer: "https://sso.example.com/realms/staff/",
        clientId: "muster",
        clientSecret: "secret",
        trustEmail: false,
        directory: false,
      },
    ]);
    expect(() => loadConfig({ ...own, MUSTER_OIDC_ISSUER: "http://sso.example.com" })).toThrow(
      /https/,
    );
    expect(() => loadConfig({ ...own, MUSTER_OIDC_CLIENT_SECRET: "" })).toThrow(
      /half set: MUSTER_OIDC_CLIENT_SECRET/,
    );
    expect(() => loadConfig({ ...base, MUSTER_MICROSOFT_CLIENT_ID: "x" })).toThrow(/Microsoft/);
    expect(() => loadConfig({ ...base, MUSTER_GOOGLE_CLIENT_SECRET: "" })).toThrow(/Google/);
  });

  it("refuses a public URL that is not a bare origin", () => {
    for (const url of [
      "https://muster.example.com/",
      "https://muster.example.com/app",
      "https://Muster.example.com",
      "muster.example.com",
    ]) {
      expect(() => loadConfig({ ...base, MUSTER_PUBLIC_URL: url }), url).toThrow(
        /MUSTER_PUBLIC_URL/,
      );
    }
  });

  it("refuses numbers that are not positive whole numbers", () => {
    expect(() => loadConfig({ ...base, MUSTER_SESSION_DAYS: "7d" })).toThrow(/MUSTER_SESSION_DAYS/);
    expect(() => loadConfig({ ...base, MUSTER_SESSION_DAYS: "0" })).toThrow(/MUSTER_SESSION_DAYS/);
    expect(() => loadConfig({ ...base, PORT: "-1" })).toThrow(/PORT/);
  });

  it("never allows the passwordless development sign-in next to a real database or site", () => {
    expect(() => loadConfig({ ...base, MUSTER_DEV: "1" })).toThrow(/MUSTER_DEV/);
    expect(() =>
      loadConfig({ MUSTER_DEV: "1", MUSTER_PUBLIC_URL: "https://muster.example.com" }),
    ).toThrow(/MUSTER_DEV/);
    expect(loadConfig({ MUSTER_DEV: "1" }).providers.map((p) => p.id)).toEqual(["dev"]);
    expect(loadConfig(base).providers.map((p) => p.id)).not.toContain("dev");
  });

  it("accepts only one directory's GUID as the Microsoft tenant", () => {
    const ms = { MUSTER_MICROSOFT_CLIENT_ID: "id", MUSTER_MICROSOFT_CLIENT_SECRET: "s" };
    // "common" and friends mean any directory; a domain name can never equal the token's tenant ID.
    for (const tenant of [
      "common",
      "organizations",
      "Consumers",
      "contoso.onmicrosoft.com",
      "8b1c-tenant",
    ]) {
      expect(() => loadConfig({ ...base, ...ms, MUSTER_MICROSOFT_TENANT: tenant }), tenant).toThrow(
        /MUSTER_MICROSOFT_TENANT/,
      );
    }
    const tenant = "8B1C2D3E-0000-4000-8000-ABCDEF012345";
    expect(
      loadConfig({ ...base, ...ms, MUSTER_MICROSOFT_TENANT: tenant }).providers.at(-1),
    ).toMatchObject({ id: "microsoft", tenant: tenant.toLowerCase() });
  });

  it("requires a provider, a database and an owner outside development", () => {
    expect(() =>
      loadConfig({ ...base, MUSTER_GOOGLE_CLIENT_ID: "", MUSTER_GOOGLE_CLIENT_SECRET: "" }),
    ).toThrow(/provider/);
    expect(() => loadConfig({ ...base, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, MUSTER_BOOTSTRAP_OWNER_EMAIL: "  " })).toThrow(/BOOTSTRAP/);
  });
});
