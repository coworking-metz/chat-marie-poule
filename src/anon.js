// Limites pour les visiteurs anonymes, SANS conserver aucun contenu : seuls des compteurs sont gardés.
//  - par visiteur : cookie `mp_anon` (identifiant aléatoire 128 bits) -> nombre de questions posées, TTL 24 h ;
//  - par IP et par jour : plafond plus large contre le contournement par suppression du cookie.
// Ni texte de question, ni IP en clair : les clés sont des condensés (sel aléatoire renouvelé chaque jour pour les IP).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const ANON_MAX_QUESTIONS = Number(process.env.ANON_MAX_QUESTIONS) || 5;
export const ANON_MAX_QUESTIONS_PER_IP_PER_DAY = Number(process.env.ANON_MAX_QUESTIONS_PER_IP_PER_DAY) || 15;
export const ANON_COOKIE = "mp_anon";
const VISITOR_TTL_MS = 24 * 3600 * 1000;
const MAX_VISITORS = 50_000;

export const LIMIT_MESSAGE = `Si vous voulez en avoir plus, vous pouvez :

- Prendre rendez-vous pour une [journée d'essai gratuite](https://rejoindre.coworking-metz.fr/) : l'équipe répondra à toutes vos questions sur place.
- [Nous contacter](https://www.coworking-metz.fr/contact/#ouvrir-brevo) via le chat de la page de contact pour échanger avec une personne.
- Vous connecter avec votre compte adhérent-e pour continuer cette discussion (bouton « Se connecter » en haut de la page).`;

/** Nombre de messages `user` d'un historique envoyé par le navigateur. */
export const userMessages = (messages) => (Array.isArray(messages) ? messages : []).filter((m) => m?.role === "user").length;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
export const validVisitorId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{22}$/.test(id);
export const newVisitorId = () => crypto.randomBytes(16).toString("base64url"); // 128 bits

export function createAnonLimiter({ file, maxQuestions = ANON_MAX_QUESTIONS, maxPerIp = ANON_MAX_QUESTIONS_PER_IP_PER_DAY, now = Date.now } = {}) {
  const FILE = path.resolve(ROOT, file || process.env.ANON_FILE || "data/anon-counters.json");
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const fresh = () => ({ day: today(), salt: crypto.randomBytes(16).toString("hex"), ips: {}, visitors: {} });
  let state = fresh();
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (s?.day === state.day && typeof s.salt === "string" && s.ips && s.visitors) state = s;
    else if (s?.visitors) state.visitors = s.visitors; // les visiteurs durent 24 h, pas « un jour calendaire »
  } catch { /* premier démarrage */ }

  let timer = null;
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => { // écriture groupée : un petit fichier de compteurs, jamais de texte
      timer = null;
      try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state), { mode: 0o600 }); } catch { /* en mémoire seulement */ }
    }, 1000);
    timer.unref?.();
  };
  const roll = () => {
    if (state.day !== today()) state = { ...fresh(), visitors: state.visitors };
    if (Object.keys(state.visitors).length > MAX_VISITORS) for (const [k, v] of Object.entries(state.visitors)) if (v.exp < now()) delete state.visitors[k];
  };
  const vk = (id) => sha(id), ik = (ip) => sha(`${state.salt}|${ip ?? "?"}`);
  const count = (id) => { const v = state.visitors[vk(id)]; return v && v.exp > now() ? v.n : 0; };

  return {
    /** Questions déjà posées par ce visiteur (cookie) et par cette IP aujourd'hui. */
    status(id, ip) { roll(); return { n: count(id), ip: state.ips[ik(ip)] ?? 0 }; },
    /** true si une nouvelle question est permise ; `history` = historique envoyé (ne doit pas dépasser la limite). */
    allowed(id, ip, history) {
      const { n, ip: c } = this.status(id, ip);
      return n < maxQuestions && c < maxPerIp && userMessages(history) <= maxQuestions;
    },
    /** Compte une question acceptée ; renvoie le nombre de questions restantes pour ce visiteur. */
    record(id, ip) {
      roll();
      const k = vk(id), v = state.visitors[k];
      state.visitors[k] = { n: (v && v.exp > now() ? v.n : 0) + 1, exp: v && v.exp > now() ? v.exp : now() + VISITOR_TTL_MS };
      state.ips[ik(ip)] = (state.ips[ik(ip)] ?? 0) + 1;
      save();
      return Math.max(0, maxQuestions - state.visitors[k].n);
    },
    /** Annule le comptage d'une question dont la réponse a échoué (erreur technique). */
    refund(id, ip) {
      const k = vk(id), v = state.visitors[k];
      if (v && v.n > 0) v.n--;
      const i = ik(ip); if (state.ips[i] > 0) state.ips[i]--;
      save();
    },
  };
}
