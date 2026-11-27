const $ = (s) => document.querySelector(s);
const app = $("#app"), log = $("#log"), form = $("#form"), q = $("#q"), send = $("#send"), reset = $("#reset"), pdfBtn = $("#pdf");
// Aucune conversation n'est conservée côté serveur : l'historique vit ici et dans sessionStorage (cet onglet seulement).
let messages = [];
let busy = false;
let limited = false;    // visiteur anonyme ayant atteint sa limite de questions
let me = { connecte: false, sso: false };
const limitBox = $("#limit"), loginBtn = $("#login"), userBox = $("#user"), userBtn = $("#user-btn"), userMenu = $("#user-menu");

// Mémoire de l'onglet : survit à un rechargement (et au retour d'une connexion), disparaît à la fermeture de l'onglet.
// `limited` est conservé à part : « Nouvelle question » efface la conversation mais pas le compteur (qui est côté serveur).
const SK = "marie-poule:conversation", SK_LIMIT = "marie-poule:limite";
const store = {
  load() { try { const v = JSON.parse(sessionStorage.getItem(SK) || "[]"); return Array.isArray(v) ? v.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : []; } catch { return []; } },
  save() { try { sessionStorage.setItem(SK, JSON.stringify(messages)); } catch {} },
  loadLimit() { try { return sessionStorage.getItem(SK_LIMIT) === "1"; } catch { return false; } },
  saveLimit() { try { limited ? sessionStorage.setItem(SK_LIMIT, "1") : sessionStorage.removeItem(SK_LIMIT); } catch {} },
};

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

// Défilement : on va à la fin réelle du document (le composeur sticky et le pied de page
// y sont dans le flux, donc plus rien n'est masqué). Pas de "smooth" : il est interrompu par les rendus suivants.
const root = document.scrollingElement || document.documentElement;
const nearBottom = () => root.scrollHeight - root.scrollTop - window.innerHeight < 120;
function scrollToBottom() {
  root.scrollTop = root.scrollHeight;
  // Re-vérifie après la mise en page (images, polices, retrait de l'indicateur, hauteur du textarea).
  requestAnimationFrame(() => { root.scrollTop = root.scrollHeight; });
}

function add(role, text, cls = "") {
  const stick = role === "user" || nearBottom();
  const d = document.createElement("div");
  d.className = `msg ${role} ${cls}`.trim();
  if (role === "user") d.textContent = text; else d.innerHTML = render(text);
  log.append(d);
  if (stick) scrollToBottom();
  return d;
}
function setState() {
  app.dataset.state = messages.length ? "chat" : "home";
  reset.hidden = !messages.length;
  pdfBtn.hidden = !messages.some((m) => m.role === "assistant");
  pdfBtn.disabled = busy;
  limitBox.hidden = !limited;
  $("#limit-login").hidden = !me.sso;
  form.dataset.off = limited ? "1" : "";
  if (!limited) delete form.dataset.off;
  q.disabled = limited; send.disabled = limited || busy;
  q.placeholder = limited ? "Connectez-vous pour continuer" : "Écrivez votre question…";
}
function setLimited(v) { limited = v; setState(); if (v) scrollToBottom(); }
function clearAll() { messages = []; log.innerHTML = ""; store.save(); setState(); } // le compteur de questions (serveur) et `limited` restent

async function ask(text) {
  if (busy || !text.trim()) return;
  if (limited) return;
  busy = true; send.disabled = true;
  messages.push({ role: "user", content: text.trim() });
  setState(); add("user", text.trim());
  q.value = ""; grow(); scrollToBottom();

  const wait = document.createElement("div");
  wait.className = "status"; wait.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  log.append(wait); scrollToBottom();
  let bubble = null, acc = "", failed = false, atLimit = false, nowLimited = false;

  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: messages.slice(-10) }) });
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
        if (ev === "status") { if (!wait.isConnected) log.append(wait); wait.innerHTML = esc(data.text); scrollToBottom(); }
        else if (ev === "reset") {
          // Texte écrit avant un appel d'outil : ce n'est pas la réponse, on l'efface et on réaffiche l'attente.
          acc = ""; if (bubble) { bubble.remove(); bubble = null; }
          wait.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>'; if (!wait.isConnected) log.append(wait);
        } else if (ev === "limit") { atLimit = true; wait.remove(); }
        else if (ev === "done") { if (data.restantes === 0) nowLimited = true; }
        else if (ev === "delta") {
          acc += data.text;
          if (!bubble) { wait.remove(); bubble = add("bot", acc); } else { const stick = nearBottom(); bubble.innerHTML = render(acc); if (stick) scrollToBottom(); }
        } else if (ev === "error") { failed = true; wait.remove(); add("bot", data.text, "error"); }
      }
    }
  } catch (e) {
    failed = true; wait.remove(); add("bot", e.message, "error");
  } finally {
    const stick = nearBottom();
    wait.remove();
    if (atLimit) { messages.pop(); log.lastElementChild?.classList.contains("user") && log.lastElementChild.remove(); limited = true; }
    else if (acc && !failed) messages.push({ role: "assistant", content: acc });
    else if (failed || !acc) messages.pop(); // la question reste affichée mais n'est pas rejouée
    if (nowLimited && !failed) limited = true;
    store.save(); store.saveLimit();
    busy = false; setState(); if (!limited) q.focus({ preventScroll: true });
    if (stick) scrollToBottom();
  }
}

function grow() { const stick = nearBottom(); q.style.height = "auto"; q.style.height = `${Math.min(q.scrollHeight, 150)}px`; if (stick) scrollToBottom(); }
q.addEventListener("input", grow);
q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
form.addEventListener("submit", (e) => { e.preventDefault(); ask(q.value); });
document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));
reset.addEventListener("click", () => { clearAll(); q.focus(); });
pdfBtn.addEventListener("click", async () => {
  if (busy || !messages.length) return;
  pdfBtn.disabled = true; const label = pdfBtn.textContent; pdfBtn.textContent = "Préparation du PDF…";
  try {
    const res = await fetch("/api/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: messages.slice(-40) }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Le PDF n'a pas pu être généré.");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = `conversation-marie-poule-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) { add("bot", e.message, "error"); }
  finally { pdfBtn.textContent = label; pdfBtn.disabled = busy; }
});

// --- Compte : bouton en haut à droite ---
const here = () => "/auth/login";
function renderAccount() {
  loginBtn.hidden = !me.sso || me.connecte;
  userBox.hidden = !me.connecte;
  loginBtn.href = here(); $("#limit-login").href = here();
  if (me.connecte) { $("#user-name").textContent = me.nom; $("#avatar").textContent = [...me.nom][0]?.toUpperCase() ?? "?"; }
}
function closeMenu(focus) { userMenu.hidden = true; userBtn.setAttribute("aria-expanded", "false"); if (focus) userBtn.focus(); }
userBtn.addEventListener("click", () => {
  const open = userMenu.hidden;
  userMenu.hidden = !open; userBtn.setAttribute("aria-expanded", String(open));
  if (open) $("#logout").focus();
});
document.addEventListener("click", (e) => { if (!userMenu.hidden && !userBox.contains(e.target)) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !userMenu.hidden) closeMenu(true); });
userMenu.addEventListener("focusout", (e) => { if (!userBox.contains(e.relatedTarget)) closeMenu(); });
$("#logout").addEventListener("click", async () => {
  try { await fetch("/auth/logout", { method: "POST", headers: { "X-Requested-With": "fetch" } }); } catch {}
  location.href = "/"; // retour à l'accueil, en mode anonyme
});
try { const r = await fetch("/api/me"); if (r.ok) me = await r.json(); } catch {}
renderAccount();
// Reprise de la conversation de l'onglet (rechargement, retour de connexion). Une personne connectée n'est pas limitée.
messages = store.load();
limited = store.loadLimit() && !me.connecte;
for (const x of messages) add(x.role === "user" ? "user" : "bot", x.content);
if (!me.connecte) store.saveLimit(); else { limited = false; store.saveLimit(); }
setState();
{ // retour d'une tentative de connexion
  const p = new URLSearchParams(location.search).get("connexion");
  if (p) { try { history.replaceState(null, "", location.pathname); } catch {} }
  if (p === "echec" || p === "refusee") { add("bot", p === "refusee" ? "La connexion a été annulée. Vous pouvez réessayer quand vous le souhaitez." : "La connexion à votre compte n'a pas abouti. Réessayez dans un instant.", "error"); app.dataset.state = "chat"; }
}
scrollToBottom();
