/** Small pieces of wording that are the same in every language. */

/** A count in few characters: 950, 1.2K, 34K, 5.6M. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const [divisor, unit] = abs < 1_000_000 ? [1000, "K"] : abs < 1e9 ? [1_000_000, "M"] : [1e9, "B"];
  const value = n / divisor;
  return `${Math.abs(value) < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}${unit}`;
}

/** Money kept as millionths of a US dollar. Small amounts keep more digits so they do not read as nothing. */
export function money(micros: number): string {
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(dollars !== 0 && Math.abs(dollars) < 0.01 ? 4 : 2)}`;
}

/** Whole minutes until a time, never less than zero; null when there is no time. */
export function minutesLeft(until: string | undefined, now: number): number | null {
  if (!until) return null;
  const at = Date.parse(until);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 60_000));
}

/** What kind of device a session's user agent names, or null when it cannot be told. */
export function deviceName(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const system = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Macintosh|Mac OS X|Darwin|CFNetwork/.test(userAgent)
          ? // The iOS app's own requests name only Apple's network library.
            /CFNetwork/.test(userAgent) && !/Macintosh/.test(userAgent)
            ? "iOS"
            : "Mac"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : /Electron\//.test(userAgent)
            ? "Muster"
            : null;
  if (system && browser) return `${browser} · ${system}`;
  return system ?? browser;
}

/** Words that set how a part of a reply looks; they are not part of what it says. */
const SETTINGS = new Set(["info", "warning", "success", "body", "muted", "bar", "line", "area"]);

/**
 * A reply as words a person can paste somewhere else. Replies are written in OpenUI Lang; what
 * a person wants on the clipboard is the text in it, in order, not the notation around it.
 */
export function readableReply(content: string): string {
  const text = content.trim();
  if (!/^\s*[A-Za-z_$][\w$]*\s*=/m.test(text)) return text;
  const parts: string[] = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    // A string followed by a colon is the name of a field, not something the reply says.
    if (/^\s*:/.test(text.slice((match.index ?? 0) + match[0].length))) continue;
    try {
      const value = String(JSON.parse(match[0])).trim();
      if (value && !SETTINGS.has(value)) parts.push(value);
    } catch {
      // Not a finished string: leave it out.
    }
  }
  return parts.length > 0 ? parts.join("\n") : text;
}
