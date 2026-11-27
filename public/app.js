const $ = (s) => document.querySelector(s);
const app = $("#app"), log = $("#log"), form = $("#form"), q = $("#q"), send = $("#send"), reset = $("#reset");
const STORE = "marie-poule-conversation";
let messages = [];
let busy = false;

try { messages = JSON.parse(sessionStorage.getItem(STORE) || "[]"); } catch { messages = []; }

// --- Markdown minimal et sûr : on échappe tout, puis gras, listes, liens https ---
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https:\/\/[^\s)<]+[^\s).,;:!?<])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
function render(md) {
  const out = []; let list = false;
  for (const raw of md.split("\n")) {
    const li = raw.match(/^\s*[-*•]\s+(.*)$/);
    if (li) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    if (raw.trim()) out.push(`<p>${inline(raw.replace(/^#{1,6}\s+/, ""))}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");
}

function add(role, text, cls = "") {
  const d = document.createElement("div");
  d.className = `msg ${role} ${cls}`.trim();
  if (role === "user") d.textContent = text; else d.innerHTML = render(text);
  log.append(d);
  d.scrollIntoView({ block: "end", behavior: "smooth" });
  return d;
}
function setState() {
  app.dataset.state = messages.length ? "chat" : "home";
  reset.hidden = !messages.length;
}
function save() { try { sessionStorage.setItem(STORE, JSON.stringify(messages.slice(-20))); } catch {} }

async function ask(text) {
  if (busy || !text.trim()) return;
  busy = true; send.disabled = true;
  messages.push({ role: "user", content: text.trim() });
  setState(); add("user", text.trim());
  q.value = ""; grow();

  const wait = document.createElement("div");
  wait.className = "status"; wait.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  log.append(wait);
  let bubble = null, acc = "", failed = false;

  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "Marie-Poule est indisponible pour le moment.");
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || "{}");
        if (ev === "status") wait.innerHTML = esc(data.text);
        else if (ev === "delta") {
          acc += data.text;
          if (!bubble) { wait.remove(); bubble = add("bot", acc); } else { bubble.innerHTML = render(acc); bubble.scrollIntoView({ block: "end" }); }
        } else if (ev === "error") { failed = true; wait.remove(); add("bot", data.text, "error"); }
      }
    }
  } catch (e) {
    failed = true; wait.remove(); add("bot", e.message, "error");
  } finally {
    wait.remove();
    if (acc && !failed) messages.push({ role: "assistant", content: acc });
    else if (failed || !acc) messages.pop(); // la question reste affichée mais n'est pas rejouée
    save(); busy = false; send.disabled = false; q.focus();
  }
}

function grow() { q.style.height = "auto"; q.style.height = `${Math.min(q.scrollHeight, 150)}px`; }
q.addEventListener("input", grow);
q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
form.addEventListener("submit", (e) => { e.preventDefault(); ask(q.value); });
document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));
reset.addEventListener("click", () => { messages = []; log.innerHTML = ""; save(); setState(); q.focus(); });

// Restaure la conversation de la session.
for (const m of messages) add(m.role === "user" ? "user" : "bot", m.content);
setState();
