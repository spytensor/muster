/**
 * The few pages the server draws itself around sign-in (confirming a native app, the
 * development accounts): one look, the same as the web app's sign-in page, with no
 * script and nothing fetched from anywhere.
 */
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="48" height="48" aria-hidden="true"><rect width="32" height="32" rx="9" class="m0"/><g class="m1"><circle cx="10" cy="11" r="2.2"/><circle cx="10" cy="21" r="2.2"/><rect x="15" y="9.4" width="9" height="3.2" rx="1.6"/><rect x="15" y="19.4" width="9" height="3.2" rx="1.6" opacity=".55"/></g></svg>`;

const STYLE = `*{box-sizing:border-box}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#fff;color:#0d0d0d;margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;-webkit-font-smoothing:antialiased}
main{width:min(100%,400px);display:grid;gap:24px}
.m0{fill:#0d0d0d}.m1{fill:#fff}
h1{font-size:32px;line-height:1.15;letter-spacing:-.02em;font-weight:600;margin:0 0 6px}
p{color:#666970;margin:0}b{color:#0d0d0d;font-weight:600}
.stack{display:grid;gap:12px}
button,a.row{font:inherit;font-weight:500;height:52px;width:100%;border-radius:999px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0 24px;text-decoration:none;transition:background .15s,border-color .15s}
button.go{background:#0d0d0d;color:#fff;border:1px solid #0d0d0d}button.go:hover{background:#2a2a2a}
button.no,a.row{background:transparent;color:#0d0d0d;border:1px solid #0d0d0d26}
button.no:hover,a.row:hover{background:#0d0d0d0a;border-color:#0d0d0d4d}
a.row{justify-content:space-between;gap:12px}a.row span{color:#666970;font-weight:400;font-size:13px}
.note{font-size:13px}
:focus-visible{outline:3px solid #3b82f680;outline-offset:2px}
@media (prefers-color-scheme:dark){body{background:#000;color:#fff}.m0{fill:#fff}.m1{fill:#0d0d0d}p,a.row span{color:#9a9da3}b{color:#fff}
button.go{background:#fff;color:#000;border-color:#fff}button.go:hover{background:#e6e6e6}
button.no,a.row{color:#fff;border-color:#ffffff26}button.no:hover,a.row:hover{background:#ffffff0f;border-color:#ffffff4d}}`;

/** A whole page: the mark, a heading, a line under it, and what the caller puts below. */
export function authPage(page: {
  lang: string;
  title: string;
  heading: string;
  lead: string;
  below: string;
}) {
  return `<!doctype html><html lang="${page.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page.title}</title>
<style>${STYLE}</style></head><body><main>
${MARK}
<div><h1>${page.heading}</h1><p>${page.lead}</p></div>
${page.below}
</main></body></html>`;
}
