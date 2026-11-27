// Contexte personnalisé de la personne connectée. Récupéré côté serveur avec SON jeton (jamais exposé au navigateur),
// minimisé (ni e-mail, ni téléphone, ni adresse, ni identifiant technique), mis en cache 5 minutes par session.
// Source : endpoint WordPress dédié (voir PLAN.md, « Intégration WordPress / SSO ») ; à défaut, seule l'identité de base est connue.
const HTTP_TIMEOUT_MS = 6000;
export const CONTEXT_TTL_MS = 5 * 60 * 1000;

const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);
const date = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
const bool = (v) => (typeof v === "boolean" ? v : undefined);
const text = (v, n = 40) => (typeof v === "string" ? v.normalize("NFC").replace(/[^\p{L}\p{N} '’.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, n) : "");
const STATUTS = new Set(["coworker", "nomade", "visiteur", "externe", "inactif"]);

/** Ne retient que les champs attendus et de bon type (le reste est ignoré). `raw` = JSON de l'endpoint de synthèse. */
export function normalizeSummary(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const f = r.frequentation ?? {};
  const out = {
    prenom: text(r.prenom),
    statut: STATUTS.has(r.statut) ? r.statut : undefined,
    compte_cree: date(r.membre_depuis ?? r.compte_cree),
    adhesion_annee: int(r.adhesion?.derniere_annee),
    adhesion_a_jour: bool(r.adhesion?.a_jour),
    abonnement_actif: bool(r.abonnement?.actif),
    abonnement_fin: date(r.abonnement?.fin),
    solde_tickets: num(r.tickets?.solde),
    tarif_reduit: bool(r.tarif?.reduit),
    resident_blida: bool(r.tarif?.resident_blida),
    jours_30: int(f.jours_30), jours_90: int(f.jours_90), jours_6_mois: int(f.jours_6_mois), jours_total: int(f.total),
    derniere_venue: date(f.derniere_venue),
  };
  return out;
}

const fr = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const oui = (b) => (b ? "oui" : "non");

/** Texte de données (sans consigne) pour le bloc système ; `d` = résultat de normalizeSummary + identité de base. */
export function formatMember(d, today = new Date().toISOString().slice(0, 10)) {
  const L = [`Date du jour : ${fr(today)}`];
  const missing = [];
  const add = (label, v, fmt = String) => (v === undefined || v === "" ? missing.push(label) : L.push(`${label} : ${fmt(v)}`));
  add("Prénom ou pseudo", d.prenom || d.nom);
  add("Statut", d.statut);
  add("Compte créé le", d.compte_cree, fr);
  add("Adhésion à jour", d.adhesion_a_jour, oui);
  if (d.adhesion_annee !== undefined) L.push(`Dernière année d'adhésion : ${d.adhesion_annee}`);
  add("Abonnement en cours", d.abonnement_actif, oui);
  if (d.abonnement_actif && d.abonnement_fin) L.push(`Fin de l'abonnement en cours : ${fr(d.abonnement_fin)}`);
  add("Solde de tickets (journées)", d.solde_tickets);
  add("Tarif réduit accordé", d.tarif_reduit, oui);
  add("Résident de l'immeuble (Blida)", d.resident_blida, oui);
  add("Journées de présence sur les 30 derniers jours", d.jours_30);
  add("Journées de présence sur les 90 derniers jours", d.jours_90);
  add("Journées de présence sur les 6 derniers mois", d.jours_6_mois);
  add("Journées de présence au total", d.jours_total);
  if (d.jours_total !== undefined) L.push(`Droit de venir le week-end (au moins 10 journées coworkées) : ${oui(d.jours_total >= 10)}`);
  add("Dernière venue", d.derniere_venue, fr);
  if (missing.length) L.push(`Informations NON disponibles (ne pas deviner) : ${missing.join(" ; ")}`);
  return L.join("\n");
}

/**
 * @param {{url?: string, fetchImpl?: typeof fetch, now?: () => number, ttlMs?: number}} o
 * url : endpoint de synthèse WordPress (null = désactivé : identité de base seulement).
 */
export function createMembers({ url, fetchImpl = fetch, now = Date.now, ttlMs = CONTEXT_TTL_MS } = {}) {
  const cache = new Map(); // sid -> { at, data }

  async function fetchSummary(token) {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null; // 404 tant que l'endpoint n'existe pas côté WordPress ; 401/403 : jeton refusé
    return normalizeSummary(await res.json());
  }

  /** Renvoie le texte du contexte, ou null. `getToken` : () => Promise<string|null>. Ne journalise rien de personnel. */
  async function contextFor(sid, session, getToken) {
    const hit = cache.get(sid);
    if (hit && now() - hit.at < ttlMs) return hit.text;
    let summary = null;
    if (url) {
      try {
        const token = await getToken();
        if (token) summary = await fetchSummary(token);
      } catch { /* service indisponible : on se rabat sur l'identité de base */ }
    }
    const base = { nom: session.user.nom, statut: session.user.statut, compte_cree: session.user.compte_cree };
    const merged = { ...Object.fromEntries(Object.entries(base).filter(([, v]) => v)), ...Object.fromEntries(Object.entries(summary ?? {}).filter(([, v]) => v !== undefined && v !== "")) };
    const out = formatMember(merged, new Date(now()).toISOString().slice(0, 10));
    cache.set(sid, { at: now(), text: out });
    if (cache.size > 2000) for (const [k, v] of cache) if (now() - v.at >= ttlMs) cache.delete(k);
    return out;
  }

  return { contextFor, forget: (sid) => cache.delete(sid) };
}
