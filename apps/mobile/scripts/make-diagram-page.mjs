// Writes the page the app's diagram view loads: Mermaid itself, copied from node_modules, and a
// few lines that draw one diagram and report its size. The page is built at install time so the
// app carries Mermaid with it and never fetches it; nothing in the page can reach the network.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mermaid = readFileSync(join(root, "node_modules/mermaid/dist/mermaid.min.js"), "utf8")
  // The script sits inside the page: nothing in it may look like the end of a script element.
  .replaceAll("</script", "<\\/script");
const version = JSON.parse(
  readFileSync(join(root, "node_modules/mermaid/package.json"), "utf8"),
).version;

const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Nothing is loaded from anywhere: only the scripts written into this page run. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  #out { display: block; }
  #out svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }
</style>
</head>
<body>
<div id="out"></div>
<script>${mermaid}</script>
<script>
  var out = document.getElementById("out");
  var turn = 0;
  function tell(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
    window.lastMessage = message;
  }
  // Draws one diagram. Source that is not a diagram is reported, not shown: the app shows it as text.
  window.draw = async function (code, dark) {
    var mine = ++turn;
    try {
      mermaid.initialize({
        startOnLoad: false,
        // Labels are text, and nothing in a diagram can run or link out.
        securityLevel: "strict",
        theme: dark ? "dark" : "neutral",
        fontFamily: "-apple-system, system-ui, sans-serif",
      });
      if (!(await mermaid.parse(code, { suppressErrors: true }))) throw new Error("not a diagram");
      var drawn = await mermaid.render("d" + mine, code);
      if (mine !== turn) return;
      out.innerHTML = drawn.svg;
      var box = out.getBoundingClientRect();
      tell({ type: "drawn", turn: mine, height: Math.ceil(box.height) });
    } catch (error) {
      if (mine !== turn) return;
      out.textContent = "";
      tell({ type: "failed", turn: mine });
    }
  };
  tell({ type: "ready", mermaid: ${JSON.stringify(version)} });
</script>
</body>
</html>
`;

writeFileSync(
  join(root, "src/vendor/diagram-page.js"),
  `// Written by scripts/make-diagram-page.mjs from mermaid ${version}. Not kept in git.\nexport const DIAGRAM_PAGE = ${JSON.stringify(page)};\n`,
);
console.log(`diagram page written (mermaid ${version}, ${(page.length / 1e6).toFixed(1)} MB)`);
