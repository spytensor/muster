import { inflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { SignedXml } from "xml-crypto";
import { parseMetadata, readResponse, SamlProblem } from "./auth/saml.js";
import { IDP_CERT, IDP_KEY, OTHER_CERT, OTHER_KEY } from "./auth/saml.fixture.js";
import type { Net } from "./runtime/net.js";
import { SSO_LIMITS } from "./sso.js";
import { type Harness, harness, PUBLIC_URL } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;

const ENTITY = "https://idp.acme.test/saml";
const SSO = "https://idp.acme.test/sso";
const SP = `${PUBLIC_URL}/auth/saml/metadata`;
const ACS = `${PUBLIC_URL}/auth/saml/acs`;
const bare = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
const metadata = (cert = IDP_CERT) => `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${ENTITY}">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${bare(cert)}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.acme.test/post"/>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SSO}"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

/** The test's identity provider: says what it is told to, and signs it with the key it is given. */
interface Says {
  inResponseTo: string;
  email?: string;
  nameId?: string;
  audience?: string;
  recipient?: string;
  issuer?: string;
  /** Minutes from now. */
  notBefore?: number;
  notOnOrAfter?: number;
  assertionId?: string;
  key?: string;
  /** What is signed: the assertion (as Entra and Okta do by default), the whole answer, or nothing. */
  sign?: "assertion" | "response" | "none";
  algorithm?: string;
  digest?: string;
  status?: string;
  displayName?: string;
}
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
function assertion(says: Says) {
  const id = says.assertionId ?? `_a${Math.random().toString(16).slice(2)}`;
  const email = says.email ?? "dana@acme.test";
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${at(0)}"><saml:Issuer>${says.issuer ?? ENTITY}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${says.nameId ?? `id-of-${email}`}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${says.inResponseTo}" Recipient="${says.recipient ?? ACS}" NotOnOrAfter="${at(says.notOnOrAfter ?? 5)}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${at(says.notBefore ?? -1)}" NotOnOrAfter="${at(says.notOnOrAfter ?? 5)}"><saml:AudienceRestriction><saml:Audience>${says.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AttributeStatement><saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>${says.displayName ?? "Dana Reyes"}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
}
function signed(xml: string, element: "Assertion" | "Response", says: Says) {
  const signer = new SignedXml({
    privateKey: says.key ?? IDP_KEY,
    signatureAlgorithm: says.algorithm ?? "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signer.addReference({
    xpath: `/*[local-name()='${element}'] | /*/*[local-name()='${element}']`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: says.digest ?? "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml, {
    location: {
      reference: `/*[local-name()='${element}']/*[local-name()='Issuer'] | /*/*[local-name()='${element}']/*[local-name()='Issuer']`,
      action: "after",
    },
  });
  return signer.getSignedXml();
}
function answerXml(says: Says, inner = assertion(says)) {
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Math.random().toString(16).slice(2)}" Version="2.0" IssueInstant="${at(0)}" Destination="${ACS}" InResponseTo="${says.inResponseTo}"><saml:Issuer>${ENTITY}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${says.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status>${inner}</samlp:Response>`;
  const sign = says.sign ?? "assertion";
  return sign === "none"
    ? response
    : signed(response, sign === "response" ? "Response" : "Assertion", says);
}
const encoded = (xml: string) => Buffer.from(xml).toString("base64");

describe("reading what an identity provider says", () => {
  const provider = parseMetadata(metadata());
  const read = (xml: string) =>
    readResponse(encoded(xml), {
      provider,
      entityId: SP,
      acsUrl: ACS,
      now: new Date(),
    });
  const problem = (xml: string) => {
    try {
      read(xml);
      return "accepted";
    } catch (error) {
      if (error instanceof SamlProblem) return error.reason;
      throw error;
    }
  };

  it("reads its metadata: who it is, where people are sent, and what it signs with", () => {
    expect(provider).toEqual({ entityId: ENTITY, ssoUrl: SSO, certificates: [bare(IDP_CERT)] });
    for (const broken of [
      "<nothing/>",
      metadata().replace(SSO, "http://idp.acme.test/sso"),
      metadata().replace(/<KeyDescriptor.*<\/KeyDescriptor>/s, ""),
      metadata().replace(bare(IDP_CERT), "bm90IGEgY2VydGlmaWNhdGU="),
      // A document type is where entities are declared: refused before anything reads it.
      `<!DOCTYPE x [<!ENTITY a "aaaa">]>${metadata()}`,
    ])
      expect(() => parseMetadata(broken)).toThrow(SamlProblem);
  });

  it("takes a provider over plain http only on this machine, and only in development", () => {
    const local = metadata().replace(SSO, "http://127.0.0.1:8089/realms/muster/protocol/saml");
    expect(() => parseMetadata(local)).toThrow(SamlProblem);
    expect(parseMetadata(local, true).ssoUrl).toBe(
      "http://127.0.0.1:8089/realms/muster/protocol/saml",
    );
    // Development does not open it to another machine, or to a name made to look local.
    for (const elsewhere of ["http://idp.acme.test/sso", "http://127.0.0.1.evil.test/sso"])
      expect(() => parseMetadata(metadata().replace(SSO, elsewhere), true)).toThrow(SamlProblem);
  });

  it("believes an assertion the provider signed, whether it signed that or the whole answer", () => {
    for (const sign of ["assertion", "response"] as const) {
      const said = read(answerXml({ inResponseTo: "_req1", sign }));
      expect(said).toMatchObject({
        inResponseTo: "_req1",
        subject: "id-of-dana@acme.test",
        email: "dana@acme.test",
        name: "Dana Reyes",
      });
    }
  });

  it("believes nothing else", () => {
    const good = { inResponseTo: "_req1" };
    expect(problem(answerXml({ ...good, sign: "none" }))).toBe("unsigned");
    // Signed by somebody, with a key that is not the provider's.
    expect(problem(answerXml({ ...good, key: OTHER_KEY }))).toBe("signature_bad");
    // Changed after it was signed.
    expect(problem(answerXml(good).replace("dana@acme.test", "owner@acme.test"))).toBe(
      "signature_bad",
    );
    // SHA-1, for the signature or for the digest.
    expect(
      problem(answerXml({ ...good, algorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1" })),
    ).toBe("signature_weak");
    expect(problem(answerXml({ ...good, digest: "http://www.w3.org/2000/09/xmldsig#sha1" }))).toBe(
      "signature_weak",
    );
    // For another service, another address, another request, another time, from another provider.
    expect(problem(answerXml({ ...good, audience: "https://other.test/saml" }))).toBe("audience");
    expect(problem(answerXml({ ...good, recipient: "https://other.test/acs" }))).toBe(
      "confirmation",
    );
    expect(problem(answerXml({ ...good, notOnOrAfter: -10 }))).toBe("expired");
    expect(problem(answerXml({ ...good, notBefore: 10 }))).toBe("not_yet");
    expect(problem(answerXml({ ...good, issuer: "https://evil.test/saml" }))).toBe("issuer");
    expect(
      problem(answerXml({ ...good, status: "urn:oasis:names:tc:SAML:2.0:status:Responder" })),
    ).toBe("status");
    expect(problem(`<!DOCTYPE r [<!ENTITY a "a">]>${answerXml(good)}`)).toBe("doctype");
    expect(problem("<Response/>")).toBe("not_response");
  });

  it("is not fooled by a second assertion wrapped around or beside the signed one", () => {
    const real = answerXml({ inResponseTo: "_req1" });
    const signedAssertion = /<saml:Assertion.*<\/saml:Assertion>/s.exec(real)?.[0] as string;
    const forged = assertion({ inResponseTo: "_req1", email: "owner@acme.test" });
    // The forged one first, the signed one kept beside it.
    expect(problem(real.replace(signedAssertion, forged + signedAssertion))).not.toBe("accepted");
    // The forged one in place, the signed one hidden inside an element of the answer.
    expect(
      problem(
        real.replace(
          signedAssertion,
          `${forged}<samlp:Extensions>${signedAssertion}</samlp:Extensions>`,
        ),
      ),
    ).not.toBe("accepted");
    // The forged one carrying the real one's signature, under the real one's id.
    const signature = /<ds:Signature.*<\/ds:Signature>|<Signature.*<\/Signature>/s.exec(
      signedAssertion,
    )?.[0] as string;
    const id = /ID="([^"]+)"/.exec(signedAssertion)?.[1] as string;
    const dressed = assertion({
      inResponseTo: "_req1",
      email: "owner@acme.test",
      assertionId: id,
    }).replace("</saml:Issuer>", `</saml:Issuer>${signature}`);
    const hidden = `<samlp:Extensions>${signedAssertion}</samlp:Extensions>`;
    for (const wrapped of [
      real.replace(signedAssertion, dressed + hidden),
      real.replace(signedAssertion, hidden + dressed),
      real.replace(signedAssertion, dressed),
    ]) {
      // Whatever is accepted says what the provider signed, never what was put in its place.
      let said: string | null = null;
      try {
        said = read(wrapped).email;
      } catch (error) {
        if (!(error instanceof SamlProblem)) throw error;
      }
      expect(said).not.toBe("owner@acme.test");
    }
  });
});

describe("signing in through the company's identity provider", () => {
  let h: Harness;
  let owner: string;
  let admin: string;
  let mo: string;
  const net: Net = {
    request: async (url) =>
      url === "https://idp.acme.test/metadata"
        ? { status: 200, contentType: "application/xml", text: metadata(), truncated: false, url }
        : { status: 404, contentType: "text/plain", text: "", truncated: false, url },
  };
  const requestOf = (location: string) => {
    const to = new URL(location);
    expect(`${to.origin}${to.pathname}`).toBe(SSO);
    const request = inflateRawSync(
      Buffer.from(to.searchParams.get("SAMLRequest") ?? "", "base64"),
    ).toString();
    expect(request).toContain(`AssertionConsumerServiceURL="${ACS}"`);
    expect(request).toContain(`<saml:Issuer>${SP}</saml:Issuer>`);
    return /ID="([^"]+)"/.exec(request)?.[1] as string;
  };
  /** Begins at the sign-in page as a browser would; returns the request's id and the cookie that binds it. */
  const begin = async () => {
    const sent = await h.app.request("/auth/login/saml");
    expect(sent.status).toBe(302);
    return {
      id: requestOf(sent.headers.get("location") ?? ""),
      cookie: sent.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  };
  /** Begins in the console, signed in: "Try it" and "Connect my account". */
  const beginAs = async (session: string) => {
    const sent = await h.api(session, "POST", "/api/settings/sso/saml/try");
    if (sent.status !== 200) return { status: sent.status, id: "", cookie: "" };
    return {
      status: 200,
      id: requestOf((await json<{ url: string }>(sent)).url),
      cookie: sent.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  };
  /** The provider's page posts its answer from its own site: no cookie of ours goes with it. */
  const post = (xml: string) =>
    h.app.request("/auth/saml/acs", {
      method: "POST",
      headers: {
        origin: "https://idp.acme.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ SAMLResponse: encoded(xml) }).toString(),
    });
  const finish = async (answered: Response, cookie: string) => {
    const to = answered.headers.get("location") ?? "";
    if (!to.includes("/auth/saml/done"))
      return { cookie: null, error: new URL(to).searchParams.get("error"), to };
    const done = await h.app.request(to.slice(PUBLIC_URL.length), { headers: { cookie } });
    const session = done.headers.getSetCookie().find((one) => one.startsWith("muster_session="));
    const landed = done.headers.get("location") ?? "";
    return {
      cookie: session?.split(";")[0] ?? null,
      error: new URL(landed).searchParams.get("error"),
      to: landed,
    };
  };
  const signIn = async (says: Omit<Says, "inResponseTo"> = {}) => {
    const { id, cookie } = await begin();
    return finish(await post(answerXml({ ...says, inResponseTo: id })), cookie);
  };
  /** The whole of "Try it": begun signed in, answered by the provider, ended in the same browser. */
  const connect = async (session: string, says: Omit<Says, "inResponseTo"> = {}) => {
    const { status, id, cookie } = await beginAs(session);
    if (status !== 200) return { status, error: null as string | null, to: "", cookie: null };
    return {
      status,
      ...(await finish(
        await post(answerXml({ ...says, inResponseTo: id })),
        `${cookie}; ${session}`,
      )),
    };
  };
  const me = async (cookie: string | null) =>
    json<{ user: { email: string }; role: string }>(await h.api(cookie, "GET", "/api/me"));
  const sso = async () =>
    json<{
      saml: { enabled: boolean; verified: boolean; entityId: string } | null;
      service: { entityId: string; acsUrl: string };
      owner: boolean;
    }>(await h.api(owner, "GET", "/api/settings/sso"));
  const providers = async () => json(await h.app.request("/auth/providers"));
  const events = async () => JSON.stringify(await json(await h.api(owner, "GET", "/api/audit")));

  beforeAll(async () => {
    // These tests begin more sign-ins in a second than a person does in a day.
    SSO_LIMITS.beginPerMinute = 10_000;
    h = await harness({}, { net });
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    await h.api(owner, "POST", "/api/invitations", { email: "ada@acme.test", role: "admin" });
    mo = (await h.signIn("mo@acme.test")).cookie as string;
    admin = (await h.signIn("ada@acme.test")).cookie as string;
    // The organization's own domain: new people are let in only at an address in it.
    expect(
      (await h.api(owner, "PUT", "/api/settings/sign-in/domains/acme.test", { autoJoin: false }))
        .status,
    ).toBe(200);
  });

  it("is an owner's to set up, and lets nobody in until an owner has tried it and switched it on", async () => {
    // Not a member's, and not an administrator's: it decides who gets into every account.
    for (const [who, status] of [
      [mo, 403],
      [admin, 403],
    ] as const) {
      expect(
        (await h.api(who, "PUT", "/api/settings/sso/saml", { metadataXml: metadata(OTHER_CERT) }))
          .status,
      ).toBe(status);
      expect((await h.api(who, "PUT", "/api/settings/sso/saml/enabled", { on: true })).status).toBe(
        403,
      );
      expect((await h.api(who, "DELETE", "/api/settings/sso/saml")).status).toBe(403);
    }
    expect((await h.api(mo, "GET", "/api/settings/sso")).status).toBe(403);
    for (const bad of [
      { metadataXml: "<nothing/>" },
      { metadataUrl: "http://idp.acme.test/metadata" },
      {},
    ])
      expect((await h.api(owner, "PUT", "/api/settings/sso/saml", bad)).status).toBe(400);
    expect(
      (
        await h.api(owner, "PUT", "/api/settings/sso/saml", {
          metadataUrl: "https://idp.acme.test/gone",
        })
      ).status,
    ).toBe(502);
    expect(
      (
        await h.api(owner, "PUT", "/api/settings/sso/saml", {
          metadataUrl: "https://idp.acme.test/metadata",
        })
      ).status,
    ).toBe(200);
    const set = await sso();
    expect(set.saml).toMatchObject({ entityId: ENTITY, enabled: false, verified: false });
    expect(set).toMatchObject({ service: { entityId: SP, acsUrl: ACS }, owner: true });
    const own = await (await h.app.request("/auth/saml/metadata")).text();
    expect(own).toContain(`entityID="${SP}"`);
    expect(own).toContain(`Location="${ACS}"`);

    // Set up and not switched on: nobody gets in through it, by the page or by its address.
    expect((await h.app.request("/auth/login/saml")).status).toBe(404);
    expect(await providers()).toEqual([{ id: "dev", label: expect.any(String) }]);
    expect((await h.api(owner, "PUT", "/api/settings/sso/saml/enabled", { on: true })).status).toBe(
      409,
    );
    // Only an owner tries it before it is on.
    expect((await beginAs(admin)).status).toBe(403);
    expect((await beginAs(mo)).status).toBe(403);

    // The owner tries it. The provider may call them anything: who they are is their
    // session. Their account at the provider becomes theirs, and nothing else happens.
    const before = await h.db.query("select user_id from memberships order by user_id");
    const tried = await connect(owner, {
      email: "somebody@elsewhere.test",
      nameId: "owner-at-idp",
    });
    expect(tried).toMatchObject({ error: null, cookie: null });
    expect(tried.to).toBe(`${PUBLIC_URL}/#/admin/security`);
    expect(await h.db.query("select user_id from memberships order by user_id")).toEqual(before);
    expect(await me(owner)).toMatchObject({ user: { email: "owner@acme.test" }, role: "owner" });
    expect((await sso()).saml).toMatchObject({ verified: true, enabled: false });
    // An answer to a trial ends only in the browser that is signed in as who began it.
    const stolen = await beginAs(owner);
    const answered = await post(answerXml({ inResponseTo: stolen.id, nameId: "thief-at-idp" }));
    expect((await finish(answered, stolen.cookie)).error).toBe("failed");
    const again = await beginAs(owner);
    const second = await post(answerXml({ inResponseTo: again.id, nameId: "thief-at-idp" }));
    expect((await finish(second, `${again.cookie}; ${mo}`)).error).toBe("failed");

    expect((await h.api(owner, "PUT", "/api/settings/sso/saml/enabled", { on: true })).status).toBe(
      200,
    );
    expect(await providers()).toEqual([{ id: "saml", label: "Single sign-on" }]);
    const log = await events();
    for (const action of ["sso.saml_set", "sso.saml_connected", "sso.saml_on"])
      expect(log).toContain(action);
  });

  it("lets in who the provider names, and never hands anyone an account by naming its address", async () => {
    // The owner, by the account they connected.
    const boss = await signIn({ email: "whatever@acme.test", nameId: "owner-at-idp" });
    expect(await me(boss.cookie)).toMatchObject({
      user: { email: "owner@acme.test" },
      role: "owner",
    });
    // Someone new at an address in the organization's domain is a member by signing in.
    const dana = await signIn({ email: "dana@acme.test" });
    expect(await me(dana.cookie)).toMatchObject({
      user: { email: "dana@acme.test" },
      role: "member",
    });
    // The same account again is the same person, whatever address the provider now gives.
    const again = await signIn({ email: "dana.reyes@acme.test", nameId: "id-of-dana@acme.test" });
    expect(await me(again.cookie)).toMatchObject({ user: { email: "dana@acme.test" } });
    // Someone new at an address outside it is not let in, and no account is made for them.
    expect((await signIn({ email: "eve@elsewhere.test" })).error).toBe("not_member");
    expect(
      (await h.db.query("select 1 from users where email = 'eve@elsewhere.test'")).length,
    ).toBe(0);

    // A plain member who was here already becomes that member: the directory is how
    // members sign in.
    const member = await signIn({ email: "mo@acme.test", nameId: "mo-at-idp" });
    expect(await me(member.cookie)).toMatchObject({
      user: { email: "mo@acme.test" },
      role: "member",
    });
    // But an owner's or an administrator's account is never given to whoever the provider
    // says has their address: not to a new account at it, with any name.
    for (const email of ["owner@acme.test", "ada@acme.test"])
      for (const nameId of ["attacker-1", "attacker-2"])
        expect((await signIn({ email, nameId })).error).toBe("identity_conflict");
    // Nor a member's, once their account at the provider is known.
    expect((await signIn({ email: "mo@acme.test", nameId: "not-mo" })).error).toBe(
      "identity_conflict",
    );
    expect((await signIn({ email: "dana@acme.test", nameId: "not-dana" })).error).toBe(
      "identity_conflict",
    );
    // An administrator connects their own, signed in; then the provider lets them in.
    expect((await connect(admin, { nameId: "ada-at-idp" })).error).toBeNull();
    const ada = await signIn({ email: "x@acme.test", nameId: "ada-at-idp" });
    expect(await me(ada.cookie)).toMatchObject({ user: { email: "ada@acme.test" }, role: "admin" });
    // An account at the provider that is somebody's is not made somebody else's.
    expect((await connect(admin, { nameId: "owner-at-idp" })).error).toBe("identity_conflict");
    const log = await events();
    expect(log).toContain("identity_conflict");
  });

  it("refuses an answer that is forged, replayed, for another browser or for nobody's request", async () => {
    const forged = await begin();
    expect(
      (
        await finish(
          await post(answerXml({ inResponseTo: forged.id, key: OTHER_KEY })),
          forged.cookie,
        )
      ).error,
    ).toBe("failed");
    expect(
      (
        await finish(
          await post(answerXml({ inResponseTo: forged.id, sign: "none" })),
          forged.cookie,
        )
      ).error,
    ).toBe("failed");
    // No request of ours was waiting for it (the provider began by itself, or made the id up).
    expect((await finish(await post(answerXml({ inResponseTo: "_nobody-asked" })), "")).error).toBe(
      "failed",
    );
    // A good answer, taken to the end by a browser that did not begin: nobody is let in.
    const mine = await begin();
    const good = answerXml({ inResponseTo: mine.id, email: "dana@acme.test" });
    const answered = await post(good);
    expect(answered.status).toBe(303);
    const other = await begin();
    expect((await finish(answered, other.cookie)).cookie).toBeNull();
    expect((await finish(answered, "")).cookie).toBeNull();
    // The one that began is: once.
    expect((await finish(answered, mine.cookie)).cookie).not.toBeNull();
    expect((await finish(answered, mine.cookie)).cookie).toBeNull();
    // The same answer posted again is not taken twice; nor is its assertion, for a new request.
    expect((await finish(await post(good), mine.cookie)).error).toBe("failed");
    const next = await begin();
    const assertionId = "_same-assertion";
    expect(
      (await finish(await post(answerXml({ inResponseTo: next.id, assertionId })), next.cookie))
        .cookie,
    ).not.toBeNull();
    const later = await begin();
    expect(
      (await finish(await post(answerXml({ inResponseTo: later.id, assertionId })), later.cookie))
        .error,
    ).toBe("failed");
    // Too much to be an answer.
    const huge = await h.app.request("/auth/saml/acs", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `SAMLResponse=${"A".repeat(800_000)}`,
    });
    expect(new URL(huge.headers.get("location") ?? "").searchParams.get("error")).toBe("failed");
    const log = await events();
    for (const why of ["signature_bad", "unasked", "replayed"]) expect(log).toContain(why);
  });

  it("keeps out who the organization suspended, and stops at once when it is switched off or changed", async () => {
    const members = await json<{ id: string; email: string }[]>(
      await h.api(owner, "GET", "/api/members"),
    );
    const dana = members.find((one) => one.email === "dana@acme.test")?.id;
    expect(
      (await h.api(owner, "PATCH", `/api/members/${dana}`, { status: "suspended" })).status,
    ).toBe(200);
    expect((await signIn({ email: "dana@acme.test" })).error).toBe("suspended");

    // Switched off while someone is at the provider's page: their answer lets nobody in.
    const midway = await begin();
    expect(
      (await h.api(owner, "PUT", "/api/settings/sso/saml/enabled", { on: false })).status,
    ).toBe(200);
    expect(
      (
        await finish(
          await post(answerXml({ inResponseTo: midway.id, nameId: "mo-at-idp" })),
          midway.cookie,
        )
      ).error,
    ).toBe("failed");
    expect((await h.app.request("/auth/login/saml")).status).toBe(404);
    expect(await providers()).toEqual([{ id: "dev", label: expect.any(String) }]);

    // Set again with another certificate: off until an owner has tried it again; what the
    // old certificate signs is no longer believed; and the people it named are who they were.
    expect(
      (await h.api(owner, "PUT", "/api/settings/sso/saml", { metadataXml: metadata(OTHER_CERT) }))
        .status,
    ).toBe(200);
    expect((await sso()).saml).toMatchObject({ enabled: false, verified: false });
    expect((await connect(owner, { nameId: "owner-at-idp" })).error).toBe("failed");
    expect((await connect(owner, { nameId: "owner-at-idp", key: OTHER_KEY })).error).toBeNull();
    expect((await h.api(owner, "PUT", "/api/settings/sso/saml/enabled", { on: true })).status).toBe(
      200,
    );
    const member = await signIn({
      nameId: "mo-at-idp",
      key: OTHER_KEY,
      email: "anything@acme.test",
    });
    expect(await me(member.cookie)).toMatchObject({ user: { email: "mo@acme.test" } });

    // With a second organization on the server, the page goes on offering the server's own ways in.
    await h.db.query(
      "insert into organizations (id, name) values ('01900000-0000-7000-8000-00000000bbbb', 'Other')",
    );
    expect(await providers()).toEqual([{ id: "dev", label: expect.any(String) }]);
    await h.db.query("delete from organizations where id = '01900000-0000-7000-8000-00000000bbbb'");

    expect((await h.api(owner, "DELETE", "/api/settings/sso/saml")).status).toBe(200);
    expect((await sso()).saml).toBeNull();
    expect((await h.app.request("/auth/login/saml")).status).toBe(404);
  });

  it("does not let one address begin sign-ins without end", async () => {
    SSO_LIMITS.beginPerMinute = 20;
    const fresh = await harness({}, { net });
    const boss = (await fresh.signIn("owner@acme.test")).cookie as string;
    await fresh.api(boss, "PUT", "/api/settings/sso/saml", { metadataXml: metadata() });
    await fresh.db.query("update saml_settings set enabled = true");
    let last = 302;
    let n = 0;
    for (; n < 40 && last === 302; n++) last = (await fresh.app.request("/auth/login/saml")).status;
    expect(last).toBe(429);
    expect(n).toBe(21);
    // What was begun and never answered is not kept for ever.
    await fresh.db.query("update saml_requests set created_at = now() - interval '11 minutes'");
    expect((await fresh.api(boss, "POST", "/api/settings/sso/saml/try")).status).toBe(200);
    expect((await fresh.db.query("select 1 from saml_requests")).length).toBe(1);
    // And no more may be on their way at once than the server will hold.
    SSO_LIMITS.waiting = 1;
    expect((await fresh.api(boss, "POST", "/api/settings/sso/saml/try")).status).toBe(502);
    SSO_LIMITS.waiting = 5000;
  });
});
