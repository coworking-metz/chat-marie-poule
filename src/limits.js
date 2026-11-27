// Garde-fous : taille des entrées, débit par IP, plafond de dépense quotidien. Aucun texte de question n'est conservé.
export const MAX_QUESTION_CHARS = Number(process.env.MAX_QUESTION_CHARS) || 1000;
export const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES) || 10;
const MAX_HISTORY_CHARS = 4000; // par message d'historique (réponse de l'assistant)
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 8;
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD) || 5;

/** Valide et nettoie l'historique envoyé par le navigateur (donnée non fiable). */
export function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: "Aucun message." };
  const msgs = input.slice(-MAX_HISTORY_MESSAGES).map((m) => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    content: typeof m?.content === "string" ? m.content.trim() : "",
  }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  const last = msgs.at(-1);
  if (!last || last.role !== "user" || !last.content) return { error: "La dernière entrée doit être une question." };
  if (last.content.length > MAX_QUESTION_CHARS) return { error: `Question trop longue (${MAX_QUESTION_CHARS} caractères maximum).` };
  for (const m of msgs) {
    if (!m.content) return { error: "Message vide." };
    m.content = m.content.slice(0, m.role === "user" ? MAX_QUESTION_CHARS : MAX_HISTORY_CHARS);
  }
  // Alternance stricte : on fusionne les rôles consécutifs identiques.
  const out = [];
  for (const m of msgs) {
    if (out.at(-1)?.role === m.role) out.at(-1).content += `\n${m.content}`;
    else out.push({ ...m });
  }
  return { messages: out };
}

const hits = new Map(), pdfHits = new Map();
const PDF_RATE_LIMIT = Number(process.env.PDF_RATE_LIMIT_PER_MIN) || 30;
export const pdfRateLimited = (key) => rateLimited(key, PDF_RATE_LIMIT, pdfHits);
export function rateLimited(ip, limit = RATE_LIMIT, hits_ = hits) {
  const now = Date.now();
  const arr = (hits_.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits_.set(ip, arr);
  if (hits_.size > 5000) for (const [k, v] of hits_) if (!v.some((t) => now - t < 60_000)) hits_.delete(k);
  return arr.length > limit;
}

// Compteurs anonymes (RGPD) : dépense estimée du jour, nombre de questions.
const stats = { day: "", usd: 0, questions: 0 };
function roll() {
  const d = new Date().toISOString().slice(0, 10);
  if (stats.day !== d) Object.assign(stats, { day: d, usd: 0, questions: 0 });
}
// Tarifs en USD par million de tokens, selon le modèle utilisé (PRICE_INPUT_PER_M / PRICE_OUTPUT_PER_M ;
// défaut : Sonnet 5.5 = 2 / 10). Cache Anthropic : lecture 0,05 x et écriture 1,25 x le prix d'entrée
// (ratios du calcul historique) ; les fournisseurs OpenAI-compatibles n'en déclarent pas (tout est compté en entrée).
const priceNum = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export const PRICE_INPUT = priceNum(process.env.PRICE_INPUT_PER_M, 2);
export const PRICE_OUTPUT = priceNum(process.env.PRICE_OUTPUT_PER_M, 10);
/**
 * u = { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } ; renvoie le coût estimé de cet appel.
 * `price` = { input, output } en USD par million de tokens : celui du profil de modèle utilisé (défaut : PRICE_*, profil membre).
 */
export function usageCost(u = {}, price = { input: PRICE_INPUT, output: PRICE_OUTPUT }) {
  return (
    ((u.input_tokens ?? 0) * price.input + (u.output_tokens ?? 0) * price.output + (u.cache_read_input_tokens ?? 0) * price.input * 0.05 + (u.cache_creation_input_tokens ?? 0) * price.input * 1.25) /
    1e6
  );
}
/** Ajoute l'usage au compteur du jour (une dépense commune à tous les profils) ; renvoie { input, output, usd } pour cet appel. */
export function addUsage(u = {}, price) {
  roll();
  const usd = usageCost(u, price);
  stats.usd += usd;
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return { input, output: u.output_tokens ?? 0, usd };
}
export function countQuestion() {
  roll();
  stats.questions++;
}
export function budgetExceeded() {
  roll();
  return stats.usd >= DAILY_BUDGET_USD;
}
export function publicStats() {
  roll();
  return { day: stats.day, questions: stats.questions, spend_usd: Number(stats.usd.toFixed(3)), budget_usd: DAILY_BUDGET_USD };
}
