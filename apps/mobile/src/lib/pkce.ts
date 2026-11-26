/**
 * The pure parts of sign-in for a native app. The app makes a secret (the verifier), sends only
 * its SHA-256 (the challenge) through the browser, and later proves it holds the secret.
 */

export const APP_REDIRECT = "muster://auth";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Bytes as base64url without padding. */
export function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += ALPHABET[c & 63];
  }
  return out;
}

/** The secret the app keeps: 32 random bytes give 43 characters, the shortest the server accepts. */
export function verifierFrom(random: Uint8Array): string {
  if (random.length < 32) throw new Error("a verifier needs at least 32 random bytes");
  return base64Url(random);
}

/** Ordinary base64 (what the platform's SHA-256 returns) as base64url without padding. */
export const challengeFromBase64 = (digest: string) =>
  digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Where the system browser is sent to start signing in. */
export const startUrl = (server: string, challenge: string) =>
  `${server}/auth/app/start?challenge=${encodeURIComponent(challenge)}&redirect=${encodeURIComponent(APP_REDIRECT)}`;

/** The one-time code from the address the browser was sent back to, or null if it is not ours. */
export function codeFrom(url: string): string | null {
  if (!url.startsWith(`${APP_REDIRECT}?`) && !url.startsWith(`${APP_REDIRECT}/?`)) return null;
  const query = url.slice(url.indexOf("?") + 1).split("#")[0] ?? "";
  for (const pair of query.split("&")) {
    const [key, value = ""] = pair.split("=");
    if (key === "code" && value) return decodeURIComponent(value);
  }
  return null;
}

/** A server address as typed by a person, tidied; null if it is not an http(s) address. */
export function serverUrlFrom(input: string): string | null {
  const text = input.trim().replace(/\/+$/, "");
  const match = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?$/.exec(text);
  return match ? text : null;
}
