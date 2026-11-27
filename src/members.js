// Contexte personnalisé de la personne connectée. Récupéré côté serveur avec SON jeton (jamais exposé au navigateur),
// minimisé (ni e-mail, ni téléphone, ni adresse, ni identifiant technique), mis en cache 5 minutes par session.
// Source : endpoint WordPress dédié (voir PLAN.md, « Intégration WordPress / SSO ») ; à défaut, seule l'identité de base est connue.
const HTTP_TIMEOUT_MS = 8000;
export const CONTEXT_TTL_MS = 5 * 60 * 1000;

const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);
const date = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
const bool = (v) => (typeof v === "boolean" ? v : undefined);
const text = (v, n = 40) => (typeof v === "string" ? v.normalize("NFC").replace(/[^\p{L}\p{N} '’.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, n) : "");
const STATUTS = new Set(["coworker", "nomade", "visiteur", "externe", "inactif"]);
const SECTIONS = new Set(["adhesion", "abonnement", "carnets", "tarif", "presences", "droits", "nomade", "achats"]);
const CATEGORIES = new Set(["abonnement", "carnet", "nomade", "adhesion", "contribution", "impression", "autre"]);
const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const month = (v) => (typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? v : undefined);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

/** Ne retient que les champs attendus et de bon type (le reste est ignoré). `raw` = JSON de l'endpoint de synthèse (voir deploy/wordpress/README.md). */
export function normalizeSummary(raw) {
  const r = obj(raw);
  const ad = obj(r.adherent), ab = obj(r.abonnement), ca = obj(r.carnets), ta = obj(r.tarif), no = obj(r.nomade), pr = obj(r.presences), st = obj(r.statistiques), dr = obj(r.droits), re = obj(r.achats_resume);
  const pj = obj(st.par_jour_semaine);
  const out = {
    prenom: text(r.prenom),
    compte_cree: date(r.membre_depuis),
    adhesion_a_jour: bool(ad.a_jour), adhesion_annee: int(ad.derniere_annee), adhesion_fin: date(ad.fin),
    abonnement_en_cours: bool(ab.en_cours), abonnement_debut: date(ab.debut), abonnement_fin: date(ab.fin), abonnement_jours_restants: int(ab.jours_restants),
    solde_tickets: num(ca.solde),
    tarif_type: ["normal", "reduit", "resident"].includes(ta.type) ? ta.type : undefined,
    nomade: bool(no.actif), nomade_a_venir: arr(no.dates_a_venir, 5).map(date).filter(Boolean), nomade_derniere: date(no.derniere_date),
    jours_30: int(pr.jours_30), jours_90: int(pr.jours_90), jours_total: int(pr.total), derniere_venue: date(pr.derniere_venue),
    premiere_venue: date(st.premiere_venue),
    moyenne_mensuelle: num(st.moyenne_mensuelle_12),
    par_mois: arr(st.par_mois_12, 12).map((m) => ({ mois: month(obj(m).mois), jours: int(obj(m).jours) })).filter((m) => m.mois && m.jours !== undefined),
    par_jour: JOURS.map((j) => [j, int(pj[j])]).filter(([, n]) => n !== undefined),
    mois_record: month(obj(st.mois_record).mois) && int(obj(st.mois_record).jours) !== undefined ? { mois: st.mois_record.mois, jours: int(st.mois_record.jours) } : undefined,
    semaines_consecutives: int(st.semaines_consecutives),
    types: Object.fromEntries(["abonnement", "carnet", "nomade"].map((k) => [k, int(obj(st.types)[k])]).filter(([, n]) => n !== undefined)),
    week_end: bool(dr.week_end), seuil_week_end: int(dr.seuil_week_end),
    achats: r.achats === null || r.achats === undefined ? undefined : arr(r.achats, 30).map((a) => ({ date: date(obj(a).date), produit: text(obj(a).produit, 80), categorie: CATEGORIES.has(obj(a).categorie) ? a.categorie : "autre", quantite: int(obj(a).quantite), montant: num(obj(a).montant_ttc) })).filter((a) => a.produit),
    achats_total: num(re.total_ttc), achats_commandes: int(re.commandes), achats_depuis: date(re.depuis), achats_complet: bool(re.complet), achats_plus_anciens: int(re.plus_anciens),
    achats_par_categorie: Object.entries(obj(re.par_categorie)).filter(([k]) => CATEGORIES.has(k)).map(([k, v]) => [k, int(obj(v).quantite), num(obj(v).montant_ttc)]),
    indisponible: arr(r.indisponible, 20).filter((x) => SECTIONS.has(x)),
  };
  return out;
}

const fr = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const frMois = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const oui = (b) => (b ? "oui" : "non");
const eur = (n) => `${String(n).replace(".", ",")} €`;
const TARIFS = { normal: "normal", reduit: "réduit", resident: "résident de l'immeuble (Blida)" };
const ACHATS_LIGNES = 10;

/** Texte de données (sans consigne) pour le bloc système ; `d` = résultat de normalizeSummary + identité de base. */
export function formatMember(d, today = new Date().toISOString().slice(0, 10)) {
  const L = [`Date du jour : ${fr(today)}`];
  const missing = [];
  const add = (label, v, fmt = String) => (v === undefined || v === "" ? missing.push(label) : L.push(`${label} : ${fmt(v)}`));
  const off = new Set(d.indisponible ?? []);
  add("Prénom ou pseudo", d.prenom || d.nom);
  add("Compte créé le", d.compte_cree, fr);
  if (d.nomade === undefined && d.statut) L.push(`Statut approximatif du compte : ${d.statut}`);
  add("Statut nomade (ne vient qu'à la journée)", d.nomade, (v) => oui(v) + (d.nomade_a_venir?.length ? ` ; prochaines journées nomades réservées : ${d.nomade_a_venir.map(fr).join(", ")}` : "") + (d.nomade_derniere ? ` ; dernière journée nomade : ${fr(d.nomade_derniere)}` : ""));
  add("Adhésion à jour", d.adhesion_a_jour, (v) => oui(v) + (d.adhesion_annee !== undefined ? ` (dernière année d'adhésion : ${d.adhesion_annee}${d.adhesion_fin ? `, valable jusqu'au ${fr(d.adhesion_fin)}` : ""})` : ""));
  add("Abonnement en cours", d.abonnement_en_cours, (v) => (v
    ? `oui${d.abonnement_debut ? `, du ${fr(d.abonnement_debut)}` : ""}${d.abonnement_fin ? ` au ${fr(d.abonnement_fin)}` : ""}${d.abonnement_jours_restants !== undefined ? ` (${d.abonnement_jours_restants} jour(s) restant(s))` : ""}`
    : `non${d.abonnement_fin ? ` (dernier abonnement terminé le ${fr(d.abonnement_fin)})` : ""}`));
  add("Solde de carnets / tickets (journées)", d.solde_tickets);
  add("Tarif", d.tarif_type, (v) => TARIFS[v]);
  add("Journées de présence sur les 30 derniers jours", d.jours_30);
  add("Journées de présence sur les 90 derniers jours", d.jours_90);
  add("Journées de présence au total", d.jours_total);
  add("Première venue", d.premiere_venue, fr);
  add("Dernière venue", d.derniere_venue, fr);
  if (d.moyenne_mensuelle !== undefined) L.push(`Moyenne mensuelle sur 12 mois : ${String(d.moyenne_mensuelle).replace(".", ",")} journée(s)`);
  if (d.par_mois?.length) L.push(`Journées par mois (12 derniers mois) : ${d.par_mois.map((m) => `${m.mois} : ${m.jours}`).join(" ; ")}`);
  if (d.mois_record) L.push(`Mois le plus fréquenté : ${frMois(d.mois_record.mois)} (${d.mois_record.jours} journées)`);
  if (d.par_jour?.length) L.push(`Journées par jour de semaine : ${d.par_jour.map(([j, n]) => `${j} ${n}`).join(", ")}`);
  if (d.semaines_consecutives !== undefined) L.push(`Régularité : ${d.semaines_consecutives} semaine(s) consécutive(s) avec au moins une venue`);
  const t = Object.entries(d.types ?? {});
  if (t.length) L.push(`Nature des journées : ${t.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (d.week_end === undefined && d.jours_total !== undefined) d = { ...d, week_end: d.jours_total >= 10, seuil_week_end: 10 };
  if (d.week_end !== undefined) L.push(`Droit de venir le week-end (au moins ${d.seuil_week_end ?? 10} journées coworkées) : ${oui(d.week_end)}${!d.week_end && d.jours_total !== undefined ? ` (il manque ${(d.seuil_week_end ?? 10) - d.jours_total} journée(s))` : ""}`);
  else missing.push("Droit de venir le week-end");
  if (d.jours_90 !== undefined) L.push(`Maître de stage ou d'alternance (30 journées sur 90 jours) : ${d.jours_90 >= 30 ? "condition remplie" : `non, il manque ${30 - d.jours_90} journée(s)`}`);
  if (d.achats === undefined) missing.push("Achats de la boutique");
  else {
    const cats = (d.achats_par_categorie ?? []).map(([k, q, m]) => `${k} ${q ?? "?"}${m !== undefined ? ` (${eur(m)})` : ""}`).join(", ");
    L.push(`Achats de la boutique (commandes payées) : ${d.achats_commandes ?? "?"} commande(s)${d.achats_depuis ? ` depuis le ${fr(d.achats_depuis)}` : ""}${d.achats_total !== undefined ? `, total ${eur(d.achats_total)} TTC` : ""}${d.achats_complet === false ? " (historique tronqué : seules les commandes récentes sont comptées)" : ""}${cats ? ` ; par catégorie : ${cats}` : ""}`);
    d.achats.slice(0, ACHATS_LIGNES).forEach((a) => L.push(`- ${a.date ? fr(a.date) : "date inconnue"} – ${a.produit}${a.quantite > 1 ? ` (x${a.quantite})` : ""}${a.montant !== undefined ? ` – ${eur(a.montant)}` : ""}`));
    const reste = Math.max(0, d.achats.length - ACHATS_LIGNES) + (d.achats_plus_anciens ?? 0);
    if (reste) L.push(`(${reste} autre(s) achat(s) plus ancien(s) non détaillé(s))`);
  }
  if (off.size) missing.push(...[...off].map((x) => `section « ${x} » momentanément indisponible`));
  if (missing.length) L.push(`Informations NON disponibles (ne pas deviner) : ${missing.join(" ; ")}`);
  return L.join("\n");
}

/**
 * @param {{url?: string, fetchImpl?: typeof fetch, now?: () => number, ttlMs?: number}} o
 * url : endpoint de synthèse WordPress (null = désactivé : identité de base seulement).
 */
export function createMembers({ url, fetchImpl = fetch, now = Date.now, ttlMs = CONTEXT_TTL_MS } = {}) {
  const cache = new Map(); // sid -> { exp, text }

  async function fetchSummary(token) {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null; // 404 tant que l'endpoint n'existe pas côté WordPress ; 401/403 : jeton refusé
    return normalizeSummary(await res.json());
  }

  /** Renvoie le texte du contexte, ou null. `getToken` : () => Promise<string|null>. Ne journalise rien de personnel. */
  async function contextFor(sid, session, getToken) {
    const hit = cache.get(sid);
    if (hit && now() < hit.exp) return hit.text;
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
    // repli (endpoint en échec) : on réessaie après 30 s seulement
    cache.set(sid, { exp: now() + (url && !summary ? Math.min(ttlMs, 30000) : ttlMs), text: out });
    if (cache.size > 2000) for (const [k, v] of cache) if (now() >= v.exp) cache.delete(k);
    return out;
  }

  return { contextFor, forget: (sid) => cache.delete(sid) };
}
