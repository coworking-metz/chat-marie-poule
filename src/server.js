import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Charge .env sans jamais l'afficher (Node ≥ 22).
try { process.loadEnvFile(".env"); } catch { /* variables déjà présentes dans l'environnement */ }

// CHAT_STUB : crochet réservé aux tests (remplace l'appel au modèle ; le corpus devient facultatif).
const chatModule = await import(process.env.CHAT_STUB ? new URL(process.env.CHAT_STUB, `file://${process.cwd()}/`).href : "./chat.js");
const { chat } = chatModule;
const MODEL = chatModule.MODEL ?? "stub";
const PROVIDER = chatModule.PROVIDER ?? "stub";
const EXPOSE_USAGE = process.env.EXPOSE_USAGE === "1"; // banc d'essai (test/compare.mjs) : tokens et coût par question
const { loadCorpus } = await import("./corpus.js");
const { cleanMessages, rateLimited, pdfRateLimited, budgetExceeded, countQuestion, publicStats } = await import("./limits.js");
const { createSessionStore } = await import("./sessions.js");
const { authConfig, createAuth } = await import("./auth.js");
const { createMembers } = await import("./members.js");
const { memberPrompt } = await import("./prompt.js");
const { cleanPdfMessages, conversationPdf } = await import("./pdf.js");
const { parseCookies, serializeCookie } = await import("./auth.js");
const anon = await import("./anon.js");

const PORT = Number(process.env.PORT) || 3000;
const CORS = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

let fiches;
try {
  ({ fiches } = loadCorpus());
} catch (e) {
  if (process.env.CHAT_STUB) fiches = new Map();
  else {
    console.error("Corpus introuvable : le dossier context/ (avec INDEX.md) est absent ou illisible. Il n'est pas publié ; voir la section « Corpus » du README.");
    process.exit(1);
  }
}
const cfg = authConfig();
const sessions = createSessionStore({ ttlDays: Number(process.env.SESSION_TTL_DAYS) || 7 });
sessions.purge();
setInterval(() => sessions.purge(), 3600_000).unref();
const auth = createAuth({ cfg, sessions });
const members = createMembers({ url: process.env.MEMBER_API_URL === "off" ? null : process.env.MEMBER_API_URL || (cfg.issuer && `${cfg.issuer}/api-json-wp/cowo/v1/me/summary`) });
const anonLimiter = anon.createAnonLimiter();
if (!cfg.enabled) console.log("SSO non configuré (SSO_ISSUER, SSO_CLIENT_ID, PUBLIC_URL) : mode anonyme seulement.");
const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : process.env.TRUST_PROXY);

// Jamais de cache (navigateur, Cloudflare) pour l'API et la connexion : réponses personnelles ou d'état.
app.use(["/api", "/auth"], (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors " +
      (CORS.length ? `'self' ${CORS.join(" ")}` : "'self'"),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  const origin = req.headers.origin;
  if (origin && CORS.includes(origin)) {
    res.set({ "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(auth.attach);
auth.mount(app);

// Informations affichées en bas de page : nom du modèle (MODEL_LABEL, sinon MODEL) et mention d'hébergement (MODEL_HOSTING, facultative :
// à ne renseigner que si elle est vraie, par ex. « hébergé en France chez OVHcloud »).
app.get("/api/config", (req, res) => res.json({ model: process.env.MODEL_LABEL || MODEL, hosting: process.env.MODEL_HOSTING || null }));

app.get("/api/health", (req, res) => res.json({ ok: true, provider: PROVIDER, model: MODEL, fiches: fiches.size, ...publicStats() }));

app.post("/api/chat", express.json({ limit: "64kb" }), async (req, res) => {
  const fail = (code, error) => res.status(code).json({ error });
  const user = req.user; // personne connectée (ou null)
  if (rateLimited(user ? user.sub : req.ip)) return fail(429, "Trop de questions d'affilée : patientez une minute.");
  if (budgetExceeded()) return fail(503, "Marie-Poule se repose pour aujourd'hui. Revenez demain, ou passez par la page Contact du site.");
  const sse = () => {
    res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
  };

  // Aucune conversation n'est conservée : le navigateur envoie les derniers messages { messages:[{role,content}] }.
  const { messages, error } = cleanMessages(req.body?.messages);
  if (error) return fail(400, error);

  // Visiteur anonyme : au plus ANON_MAX_QUESTIONS questions (compteur serveur par cookie, plafond par IP et par jour).
  // Refus = message fixe, sans appel au modèle. Seuls des compteurs sont conservés, jamais de texte.
  let visitor = null, restantes;
  if (!user) {
    visitor = parseCookies(req.headers.cookie)[anon.ANON_COOKIE];
    if (!anon.validVisitorId(visitor)) {
      visitor = anon.newVisitorId();
      res.append("Set-Cookie", serializeCookie(anon.ANON_COOKIE, visitor, { maxAge: 24 * 3600, secure: cfg.secure }));
    }
    if (!anonLimiter.allowed(visitor, req.ip, req.body?.messages)) {
      sse();
      res.write(`event: limit\ndata: ${JSON.stringify({ text: anon.LIMIT_MESSAGE })}\n\n`);
      return res.end();
    }
    restantes = anonLimiter.record(visitor, req.ip);
  }

  // Contexte personnalisé (jeton de la personne, côté serveur uniquement) ; absent = réponse non personnalisée.
  let memberBlock;
  if (user) {
    try { memberBlock = memberPrompt(await members.contextFor(req.sid, req.session, () => auth.accessToken(req.sid))); } catch { /* sans personnalisation */ }
  }

  countQuestion();
  sse();
  const ctl = new AbortController();
  res.on("close", () => ctl.abort());
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let ok = true;
  for await (const ev of chat(messages, ctl.signal, { memberBlock })) {
    if (ev.type === "delta" || ev.type === "refused") { send("delta", { text: ev.text }); }
    else if (ev.type === "reset") { send("reset", {}); } // narration avant un outil : ce n'est pas la réponse
    else if (ev.type === "status") send("status", { text: ev.text });
    else if (ev.type === "usage") { if (EXPOSE_USAGE) send("usage", { input: ev.input, output: ev.output, usd: ev.usd }); }
    else if (ev.type === "error") { ok = false; send("error", { text: ev.text }); }
    else if (ev.type === "done") send("done", user ? {} : { restantes });
  }
  if (visitor && (!ok || ctl.signal.aborted)) anonLimiter.refund(visitor, req.ip); // une erreur technique ne consomme pas de question
  res.end();
});

// Export PDF : le contenu est reçu, mis en forme en mémoire et renvoyé ; rien n'est écrit sur disque ni journalisé.
app.post("/api/pdf", express.json({ limit: "512kb" }), async (req, res) => {
  if (pdfRateLimited(req.user ? req.user.sub : req.ip)) return res.status(429).json({ error: "Trop de téléchargements d'affilée : patientez une minute." });
  const { messages, error } = cleanPdfMessages(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const pdf = await conversationPdf(messages);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="conversation-marie-poule-${new Date().toISOString().slice(0, 10)}.pdf"`, "Cache-Control": "no-store", "Content-Length": pdf.length });
    res.end(pdf);
  } catch (e) {
    console.error("[pdf] génération impossible", e?.code ?? e?.name);
    res.status(500).json({ error: "Le PDF n'a pas pu être généré." });
  }
});

app.use(express.static(PUBLIC, { maxAge: "5m" }));
app.use("/api", (req, res) => res.status(404).json({ error: "Introuvable." }));

app.listen(PORT, () => console.log(`Marie-Poule écoute sur http://localhost:${PORT} (${PROVIDER} / ${MODEL}, ${fiches.size} fiches)`));
