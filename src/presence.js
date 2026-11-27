// Présence en direct : lit la route JSON du site WordPress (cowo/v1/presence-now) pour l'outil `presence_en_direct`.
// Données agrégées uniquement (aucun nom). Délai 3 s, aucune relance, cache mémoire de 45 s partagé entre requêtes.
// Le résultat n'est jamais journalisé.
export const PRESENCE_URL_DEFAUT = "https://www.coworking-metz.fr/api-json-wp/cowo/v1/presence-now";
export const PRESENCE_TIMEOUT_MS = 3000;
export const PRESENCE_CACHE_MS = 45_000;
const ECHEC_CACHE_MS = 5000; // un échec n'est mémorisé que très brièvement (évite de marteler le site)
const MAX_PLAUSIBLE = 200;

let cache = null; // { jusqua, valeur }

export const resetPresenceCache = () => { cache = null; };

const entier = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Valide la réponse de la route et la réduit aux champs attendus ; renvoie null si elle est invalide. */
export function validerPresence(j) {
  if (!j || typeof j !== "object" || Array.isArray(j) || j.indisponible === true) return null;
  if (!entier(j.presents, 0, MAX_PLAUSIBLE) || !entier(j.capacite, 1, MAX_PLAUSIBLE)) return null;
  const maj = typeof j.mis_a_jour === "string" && j.mis_a_jour.length <= 40 && !Number.isNaN(Date.parse(j.mis_a_jour)) ? j.mis_a_jour : new Date().toISOString();
  return { presents: j.presents, capacite: j.capacite, libres: Math.max(0, j.capacite - j.presents), estimation: true, mis_a_jour: maj };
}

/** Résultat pour le modèle : { presents, capacite, libres, estimation, mis_a_jour } ou { indisponible: true }. */
export async function presenceEnDirect() {
  const now = Date.now();
  if (cache && cache.jusqua > now) return cache.valeur;
  let valeur = { indisponible: true };
  try {
    const url = process.env.PRESENCE_URL || PRESENCE_URL_DEFAUT;
    const res = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS) });
    if (res.ok) valeur = validerPresence(await res.json()) ?? valeur;
  } catch {
    // délai dépassé, réseau, JSON invalide : indisponible
  }
  cache = { jusqua: now + (valeur.indisponible ? ECHEC_CACHE_MS : PRESENCE_CACHE_MS), valeur };
  return valeur;
}
