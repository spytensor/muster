// The first-run page: asks which Muster server this app should talk to.
const messages = {
  en: {
    title: "Connect to Muster",
    lead: "Enter the address of your organization's Muster server. Your administrator can tell you what it is.",
    label: "Server address",
    go: "Connect",
    invalid: "That is not an address this app can use. It must start with https://",
    unreachable: "That server could not be reached. Check the address and your connection.",
    not_muster: "That address answered, but it is not a Muster server.",
    lost: (server) =>
      `${server} could not be reached. Check your connection, or enter another address.`,
  },
  zh: {
    title: "连接到 Muster",
    lead: "输入你们组织的 Muster 服务器地址。不清楚的话请问管理员。",
    label: "服务器地址",
    go: "连接",
    invalid: "这个地址无法使用，必须以 https:// 开头。",
    unreachable: "连不上这台服务器。请检查地址和网络。",
    not_muster: "这个地址有响应，但不是 Muster 服务器。",
    lost: (server) => `连不上 ${server}。请检查网络，或换一个地址。`,
  },
};
const t = messages[navigator.language.startsWith("zh") ? "zh" : "en"];
document.documentElement.lang = t === messages.zh ? "zh" : "en";
for (const node of document.querySelectorAll("[data-t]")) node.textContent = t[node.dataset.t];

const form = document.querySelector("form");
const input = form.elements.server;
const error = document.querySelector(".error");
const button = form.querySelector("button");
input.focus();
const say = (text) => {
  error.textContent = text;
  error.hidden = !text;
};

const unreachable = new URLSearchParams(location.search).get("unreachable");
if (unreachable) {
  input.value = unreachable;
  say(t.lost(unreachable));
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  say("");
  button.disabled = true;
  const problem = await window.musterDesktop.setServer(input.value);
  button.disabled = false;
  if (problem) say(t[problem] ?? t.unreachable);
});
