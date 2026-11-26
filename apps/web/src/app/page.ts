/**
 * A web page someone else wrote (an agent, or an uploaded file), made safe to show: the
 * page may style itself and show pictures it carries, and nothing else. It loads nothing
 * from anywhere and runs no script. The frame it is shown in has an empty `sandbox`, so
 * it is of no origin: it cannot read this app's cookies or storage, or call its API.
 */
export const PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
export const lockedPage = (html: string) =>
  `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}"><base target="_blank">${html}`;
