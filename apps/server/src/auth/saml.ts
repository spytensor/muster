/**
 * SAML 2.0 as a service provider, the part a company's identity provider needs: read its
 * metadata, send a person to it, and read what it answers. Nothing here touches the
 * database or the network; sso.ts does that.
 *
 * What an answer says is believed only where the provider's own certificate signed it.
 * The claims are read from the signed bytes themselves, as the signature library hands
 * them back, and never from the document as it arrived: an answer may carry a second,
 * unsigned assertion beside the signed one ("signature wrapping"), and reading the
 * document would read that one.
 */
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

/** As much of an XML element as is read here. */
interface XmlNode {
  nodeType: number;
  nextSibling: XmlNode | null;
}
interface Element extends XmlNode {
  namespaceURI: string | null;
  localName: string;
  firstChild: XmlNode | null;
  textContent: string | null;
  getAttribute(name: string): string | null;
}
// Loaded this way and described by hand: the parser's own type file switches on a
// browser's types for the whole server, and with them a second meaning of `fetch`.
const { DOMParser } = createRequire(import.meta.url)("@xmldom/xmldom") as {
  DOMParser: new (options: {
    errorHandler: Record<"warning" | "error" | "fatalError", () => void>;
  }) => { parseFromString(xml: string, type: string): { documentElement: Element | null } | null };
};

const NS = {
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
  signature: "http://www.w3.org/2000/09/xmldsig#",
};
const REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

/** The most an answer or a metadata document may weigh. A real one is a few kilobytes. */
export const SAML_MAX_BYTES = 256 * 1024;
/** How far the provider's clock and this one may disagree. */
export const SAML_SKEW_MS = 2 * 60 * 1000;

/** Signatures made with SHA-1 are not believed: it can be forged for. */
const SIGNATURES = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512",
]);
const DIGESTS = new Set([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmldsig-more#sha384",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);

export class SamlProblem extends Error {
  constructor(
    /** A word for the record; never shown to the person signing in. */
    readonly reason: string,
  ) {
    super(reason);
  }
}

/**
 * A document as elements. A document type is refused outright, before anything parses it:
 * that is where entities are declared, and an entity is how such a document is made to
 * grow without end or to read a file. SAML has no use for one.
 */
function parse(xml: string): Element {
  if (xml.length > SAML_MAX_BYTES) throw new SamlProblem("too_large");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SamlProblem("doctype");
  let broken = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => {
        broken = true;
      },
      fatalError: () => {
        broken = true;
      },
    },
  }).parseFromString(xml, "text/xml");
  const root = document?.documentElement ?? null;
  if (broken || !root) throw new SamlProblem("not_xml");
  return root;
}

const children = (parent: Element, namespace: string, name: string): Element[] => {
  const found: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (
      node.nodeType === 1 &&
      (node as Element).namespaceURI === namespace &&
      (node as Element).localName === name
    )
      found.push(node as Element);
  return found;
};
const child = (parent: Element | undefined, namespace: string, name: string) =>
  parent ? children(parent, namespace, name)[0] : undefined;
const text = (element: Element | undefined) => (element?.textContent ?? "").trim();
const is = (element: Element, namespace: string, name: string) =>
  element.namespaceURI === namespace && element.localName === name;

/** A certificate as the base64 of its bytes, whatever wrapping it came in. Throws if it is not one. */
export function certificateOf(value: string): string {
  const base64 = value.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) throw new SamlProblem("bad_certificate");
  try {
    new X509Certificate(Buffer.from(base64, "base64"));
  } catch {
    throw new SamlProblem("bad_certificate");
  }
  return base64;
}
const pem = (base64: string) =>
  `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----\n`;

/** What a certificate is known by on a page: the SHA-256 of its bytes, and when it runs out. */
export function certificateFacts(base64: string): { fingerprint: string; expires: string } {
  const certificate = new X509Certificate(Buffer.from(base64, "base64"));
  return {
    fingerprint: createHash("sha256").update(certificate.raw).digest("hex"),
    expires: new Date(certificate.validTo).toISOString(),
  };
}

export interface IdentityProvider {
  entityId: string;
  /** Where a person is sent to sign in (HTTP-Redirect binding). */
  ssoUrl: string;
  /** The certificates it signs with, base64. More than one while it changes from one to the next. */
  certificates: string[];
}

/** Reads what an identity provider publishes about itself. */
/**
 * `onThisMachine`: in development only, a provider that runs on this computer may be
 * reached over plain http (a local Keycloak, to try single sign-on against a real one).
 * Anywhere else its sign-in address is https, always.
 */
export function parseMetadata(xml: string, onThisMachine = false): IdentityProvider {
  let root = parse(xml);
  // Some publish a list of one.
  if (is(root, NS.metadata, "EntitiesDescriptor")) {
    const only = children(root, NS.metadata, "EntityDescriptor");
    if (only.length !== 1) throw new SamlProblem("metadata_many");
    root = only[0] as Element;
  }
  if (!is(root, NS.metadata, "EntityDescriptor")) throw new SamlProblem("metadata_shape");
  const entityId = root.getAttribute("entityID") ?? "";
  const idp = child(root, NS.metadata, "IDPSSODescriptor");
  if (!entityId || !idp) throw new SamlProblem("metadata_shape");
  const ssoUrl =
    children(idp, NS.metadata, "SingleSignOnService")
      .find((service) => service.getAttribute("Binding") === REDIRECT)
      ?.getAttribute("Location") ?? "";
  if (
    !/^https:\/\//.test(ssoUrl) &&
    !(onThisMachine && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(ssoUrl))
  )
    throw new SamlProblem("metadata_sso");
  const certificates = [
    ...new Set(
      children(idp, NS.metadata, "KeyDescriptor")
        // One marked for encryption only is not one it signs with.
        .filter((key) => (key.getAttribute("use") ?? "signing") === "signing")
        .flatMap((key) =>
          children(key, NS.signature, "KeyInfo").flatMap((info) =>
            children(info, NS.signature, "X509Data").flatMap((data) =>
              children(data, NS.signature, "X509Certificate").map((one) =>
                certificateOf(text(one)),
              ),
            ),
          ),
        ),
    ),
  ];
  if (certificates.length === 0) throw new SamlProblem("metadata_certificate");
  if (certificates.length > 4) throw new SamlProblem("metadata_many");
  return { entityId, ssoUrl, certificates };
}

const xmlText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What Muster publishes about itself, for the provider's side of the setup. */
export function serviceMetadata(entityId: string, acsUrl: string): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="${NS.metadata}" entityID="${xmlText(entityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="${NS.protocol}">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlText(acsUrl)}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}

/** A request to sign someone in, and the address that carries it to the provider. */
export function authnRequest(
  provider: IdentityProvider,
  service: { entityId: string; acsUrl: string },
  now: Date,
): { id: string; url: string } {
  // An xs:ID may not begin with a digit.
  const id = `_${randomBytes(20).toString("hex")}`;
  const xml = `<samlp:AuthnRequest xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${xmlText(provider.ssoUrl)}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${xmlText(service.acsUrl)}"><saml:Issuer>${xmlText(service.entityId)}</saml:Issuer></samlp:AuthnRequest>`;
  const url = new URL(provider.ssoUrl);
  url.searchParams.set("SAMLRequest", deflateRawSync(Buffer.from(xml)).toString("base64"));
  return { id, url: url.toString() };
}

export interface SamlAnswer {
  /** The request this answers, as the signed assertion says. */
  inResponseTo: string;
  /** The assertion's own id: taken once and never again. */
  assertionId: string;
  /** Until when the assertion may be presented. */
  notOnOrAfter: Date;
  /** Who the provider says this is: its lasting name for them, and their mail address. */
  subject: string;
  email: string;
  name: string;
}

const EMAIL_ATTRIBUTES = new Set([
  "email",
  "mail",
  "emailaddress",
  "user.email",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
]);
const NAME_ATTRIBUTES = new Set([
  "displayname",
  "name",
  "http://schemas.microsoft.com/identity/claims/displayname",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "urn:oid:2.16.840.1.113730.3.1.241",
]);
const GIVEN = new Set([
  "givenname",
  "firstname",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  "urn:oid:2.5.4.42",
]);
const FAMILY = new Set([
  "surname",
  "lastname",
  "sn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  "urn:oid:2.5.4.4",
]);

/**
 * The parts of `xml` that one of `certificates` signed, as the canonical text that was
 * signed. Only a signature that sits directly in the answer or directly in an assertion
 * of the answer is looked at, and only the configured certificates are tried: a key the
 * answer brings along with itself proves nothing.
 */
function signedParts(xml: string, root: Element, certificates: readonly string[]): string[] {
  const holders = [root, ...children(root, NS.assertion, "Assertion")];
  const parts: string[] = [];
  for (const holder of holders) {
    const signatures = children(holder, NS.signature, "Signature");
    if (signatures.length > 1) throw new SamlProblem("signature_many");
    const signature = signatures[0];
    if (!signature) continue;
    let good = false;
    for (const certificate of certificates) {
      const checker = new SignedXml({
        publicCert: pem(certificate),
        // Never the key written in the answer itself.
        getCertFromKeyInfo: () => null,
      });
      try {
        checker.loadSignature(signature as never);
        if (!SIGNATURES.has(checker.signatureAlgorithm ?? ""))
          throw new SamlProblem("signature_weak");
        const references = checker.getReferences();
        // One reference, to the element the signature sits in.
        if (references.length !== 1) throw new SamlProblem("signature_reference");
        if (!DIGESTS.has(references[0]?.digestAlgorithm ?? ""))
          throw new SamlProblem("signature_weak");
        const id = holder.getAttribute("ID") ?? "";
        if (!id || references[0]?.uri !== `#${id}`) throw new SamlProblem("signature_reference");
        if (!checker.checkSignature(xml)) continue;
        parts.push(...checker.getSignedReferences());
        good = true;
        break;
      } catch (error) {
        if (error instanceof SamlProblem) throw error;
        // Not this certificate, or not a signature at all: the next one is tried.
      }
    }
    // A signature that is there and is not good is never passed over for another.
    if (!good) throw new SamlProblem("signature_bad");
  }
  return parts;
}

/**
 * Reads an identity provider's answer. Throws a SamlProblem unless the provider's
 * certificate signed an assertion for this service, for this request, for now.
 */
export function readResponse(
  base64: string,
  expected: {
    provider: IdentityProvider;
    entityId: string;
    acsUrl: string;
    now: Date;
  },
): SamlAnswer {
  if (base64.length > SAML_MAX_BYTES * 2) throw new SamlProblem("too_large");
  const xml = Buffer.from(base64, "base64").toString("utf8");
  const root = parse(xml);
  if (!is(root, NS.protocol, "Response")) throw new SamlProblem("not_response");
  if (children(root, NS.assertion, "EncryptedAssertion").length > 0)
    throw new SamlProblem("encrypted");

  const parts = signedParts(xml, root, expected.provider.certificates);
  if (parts.length === 0) throw new SamlProblem("unsigned");
  // From here on, only what was signed is read.
  let assertion: Element | undefined;
  let response: Element | undefined;
  for (const part of parts) {
    const signed = parse(part);
    if (is(signed, NS.protocol, "Response")) response = signed;
    else if (is(signed, NS.assertion, "Assertion")) assertion ??= signed;
  }
  if (response) {
    // The whole answer was signed: its one assertion is the one, signed again or not.
    const inside = children(response, NS.assertion, "Assertion");
    if (inside.length !== 1) throw new SamlProblem("assertion_count");
    assertion = inside[0];
  }
  if (!assertion) throw new SamlProblem("unsigned");
  // The envelope's own words are checked wherever they are, signed or not: they can only
  // make an answer be refused, never accepted.
  const envelope = response ?? root;
  const destination = envelope.getAttribute("Destination");
  if (destination && destination !== expected.acsUrl) throw new SamlProblem("destination");
  const status = child(child(envelope, NS.protocol, "Status"), NS.protocol, "StatusCode");
  if (status?.getAttribute("Value") !== SUCCESS) throw new SamlProblem("status");
  if (children(root, NS.assertion, "Assertion").length !== 1)
    throw new SamlProblem("assertion_count");

  if (assertion.getAttribute("Version") !== "2.0") throw new SamlProblem("version");
  if (text(child(assertion, NS.assertion, "Issuer")) !== expected.provider.entityId)
    throw new SamlProblem("issuer");
  const assertionId = assertion.getAttribute("ID") ?? "";
  if (!assertionId || assertionId.length > 256) throw new SamlProblem("assertion_id");

  const now = expected.now.getTime();
  const at = (value: string | null) => {
    const time = value ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(time)) throw new SamlProblem("time");
    return time;
  };
  const conditions = child(assertion, NS.assertion, "Conditions");
  if (!conditions) throw new SamlProblem("conditions");
  const notBefore = conditions.getAttribute("NotBefore");
  if (notBefore && at(notBefore) > now + SAML_SKEW_MS) throw new SamlProblem("not_yet");
  const until = at(conditions.getAttribute("NotOnOrAfter"));
  if (until <= now - SAML_SKEW_MS) throw new SamlProblem("expired");
  const audiences = children(conditions, NS.assertion, "AudienceRestriction").flatMap((one) =>
    children(one, NS.assertion, "Audience").map(text),
  );
  if (!audiences.includes(expected.entityId)) throw new SamlProblem("audience");

  const subject = child(assertion, NS.assertion, "Subject");
  const nameId = text(child(subject, NS.assertion, "NameID"));
  if (!nameId || nameId.length > 512) throw new SamlProblem("subject");
  const confirmed = (subject ? children(subject, NS.assertion, "SubjectConfirmation") : [])
    .filter((one) => one.getAttribute("Method") === BEARER)
    .map((one) => child(one, NS.assertion, "SubjectConfirmationData"))
    .find(
      (data) =>
        data &&
        data.getAttribute("Recipient") === expected.acsUrl &&
        // An answer nobody asked for names no request: the caller looks up the one named.
        (data.getAttribute("InResponseTo") ?? "").length > 0 &&
        at(data.getAttribute("NotOnOrAfter")) > now - SAML_SKEW_MS &&
        !data.getAttribute("NotBefore"),
    );
  if (!confirmed) throw new SamlProblem("confirmation");
  const inResponseTo = confirmed.getAttribute("InResponseTo") as string;
  // Where the envelope names a request too, it is the same one.
  const envelopeAnswers = envelope.getAttribute("InResponseTo");
  if (envelopeAnswers && envelopeAnswers !== inResponseTo) throw new SamlProblem("confirmation");

  const attributes = new Map<string, string>();
  for (const statement of children(assertion, NS.assertion, "AttributeStatement"))
    for (const attribute of children(statement, NS.assertion, "Attribute")) {
      const name = (attribute.getAttribute("Name") ?? "").toLowerCase();
      const value = text(child(attribute, NS.assertion, "AttributeValue"));
      if (name && value && !attributes.has(name)) attributes.set(name, value.slice(0, 320));
    }
  const pick = (names: Set<string>) => [...attributes].find(([name]) => names.has(name))?.[1] ?? "";
  const email = pick(EMAIL_ATTRIBUTES) || (/^[^\s@]+@[^\s@]+$/.test(nameId) ? nameId : "");
  if (!email) throw new SamlProblem("no_email");
  const name = pick(NAME_ATTRIBUTES) || [pick(GIVEN), pick(FAMILY)].filter(Boolean).join(" ");
  return {
    inResponseTo,
    assertionId,
    notOnOrAfter: new Date(Math.min(until, at(confirmed.getAttribute("NotOnOrAfter")))),
    subject: nameId,
    email,
    name: name.slice(0, 200),
  };
}
