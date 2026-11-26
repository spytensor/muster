import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Two key pairs with self-signed certificates: a test identity provider's, and one that
 * is not the provider's. Made anew each time the tests load, with `openssl`, and kept
 * nowhere: no key, even one that opens nothing, is written into the repository.
 */
function pair(name: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "muster-saml-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "3650",
        "-subj",
        `/CN=${name}`,
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8").trim(),
      cert: readFileSync(join(dir, "cert.pem"), "utf8").trim(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const idp = pair("muster-test-idp");
const other = pair("muster-test-other");
export const IDP_KEY = idp.key;
export const IDP_CERT = idp.cert;
export const OTHER_KEY = other.key;
export const OTHER_CERT = other.cert;
