import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Charge .env sans jamais l'afficher (Node ≥ 22).
try { process.loadEnvFile(".env"); } catch { /* variables déjà présentes dans l'environnement */ }

const { chat, MODEL } = await import("./chat.js");
const { loadCorpus } = await import("./corpus.js");
const { cleanMessages, rateLimited, budgetExceeded, countQuestion, publicStats } = await import("./limits.js");

const PORT = Number(process.env.PORT) || 3000;
const CORS = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

let fiches;
try {
  ({ fiches } = loadCorpus());
} catch (e) {
  console.error("Corpus introuvable : le dossier context/ (avec INDEX.md) est absent ou illisible. Il n'est pas publié ; voir la section « Corpus » du README.");
  process.exit(1);
}
const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : process.env.TRUST_PROXY);

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

app.get("/api/health", (req, res) => res.json({ ok: true, model: MODEL, fiches: fiches.size, ...publicStats() }));

app.post("/api/chat", express.json({ limit: "32kb" }), async (req, res) => {
  const fail = (code, error) => res.status(code).json({ error });
  if (rateLimited(req.ip)) return fail(429, "Trop de questions d'affilée : patientez une minute.");
  if (budgetExceeded()) return fail(503, "Marie-Poule se repose pour aujourd'hui. Revenez demain, ou passez par la page Contact du site.");
  const { messages, error } = cleanMessages(req.body?.messages);
  if (error) return fail(400, error);

  countQuestion();
  res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const ctl = new AbortController();
  res.on("close", () => ctl.abort());
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for await (const ev of chat(messages, ctl.signal)) {
    if (ev.type === "delta") send("delta", { text: ev.text });
    else if (ev.type === "status") send("status", { text: ev.text });
    else if (ev.type === "refused") send("delta", { text: ev.text });
    else if (ev.type === "error") send("error", { text: ev.text });
    else if (ev.type === "done") send("done", {});
  }
  res.end();
});

app.use(express.static(PUBLIC, { maxAge: "5m" }));
app.use("/api", (req, res) => res.status(404).json({ error: "Introuvable." }));

app.listen(PORT, () => console.log(`Marie-Poule écoute sur http://localhost:${PORT} (modèle ${MODEL}, ${fiches.size} fiches)`));
