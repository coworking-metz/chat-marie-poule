// Tests hors ligne (sans appel à l'API) : corpus, outils, validation des entrées.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chercher, lireFiche, nombreFiches, indexText } from "../src/corpus.js";
import { cleanMessages, MAX_QUESTION_CHARS } from "../src/limits.js";
import { systemPrompt } from "../src/prompt.js";

const corpusPresent = fs.existsSync(new URL("../context/INDEX.md", import.meta.url));
if (corpusPresent) {
  assert.ok(nombreFiches() >= 40, "le corpus doit contenir des fiches");
  assert.ok(indexText().includes("## Catalogue des fiches"));
  assert.ok(systemPrompt().includes("coworking-metz.fr/contact"));

  // lire_fiche : chemins du catalogue valides, traversée de répertoire refusée
  assert.equal(lireFiche("themes/tarifs-et-abonnements.md").ok, true);
  assert.equal(lireFiche("../.env").ok, false);
  assert.equal(lireFiche("../../etc/passwd").ok, false);
  assert.equal(lireFiche("_SPEC.md").ok, false);
  assert.equal(lireFiche("INDEX.md").ok, false);
  // chaque chemin cité dans le catalogue existe
  const chemins = [...indexText().matchAll(/`((?:annees|themes|sources-web|images)\/[^`]+\.md)`/g)].map((m) => m[1]);
  assert.ok(chemins.length > 30);
  for (const c of new Set(chemins)) assert.equal(lireFiche(c).ok, true, `fiche du catalogue introuvable : ${c}`);

  // lire_fiche : pas de bruit (en-tête YAML retiré, lignes vides repliées), règlement jamais tronqué
  const t = lireFiche("themes/tarifs-et-abonnements.md").texte;
  assert.ok(!t.includes("\nresume:") && !t.includes("\nutile_pour:") && !/\n{3,}/.test(t));
  assert.ok(lireFiche("sources-web/reglement-interieur.md").texte.length > 10000 && !lireFiche("sources-web/reglement-interieur.md").texte.includes("fiche tronquée"));

  // chercher
  assert.ok(chercher("tarifs abonnement").texte.includes("tarifs"));
  assert.equal(chercher("").ok, false);
} else {
  console.log("corpus context/ absent (non publié) : tests du corpus ignorés");
}

// cleanMessages
assert.ok(cleanMessages([]).error);
assert.ok(cleanMessages([{ role: "assistant", content: "x" }]).error);
assert.ok(cleanMessages([{ role: "user", content: "a".repeat(MAX_QUESTION_CHARS + 1) }]).error);
const h = cleanMessages([{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "system", content: "c" }]);
assert.deepEqual(h.messages.map((m) => m.role), ["user"]); // rôle inconnu -> user, fusion des consécutifs
assert.equal(cleanMessages([{ role: "user", content: "Bonjour" }]).messages.length, 1);

// ---- PKCE, redirection de retour, cookies signés ----
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { challengeFor, newVerifier, parseCookies, cleanName, profileFromUserinfo, authConfig } from "../src/auth.js";
assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"); // vecteur RFC 7636
const v = newVerifier();
assert.match(v, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(v, newVerifier());
assert.deepEqual(parseCookies("a=1; mp_sid=x%20y; a=2"), { a: "1", mp_sid: "x y" });
assert.equal(cleanName("Camille <b>D.</b>"), "Camille bD.b"); assert.equal(cleanName("camille@example.org"), "");
const prof = profileFromUserinfo({ ID: "7", display_name: "Léa", user_email: "x@y.z", roles: ["inactive"], user_registered: "2020-01-02 03:04:05" });
assert.deepEqual(prof, { sub: "wp:7", nom: "Léa", statut: "inactif", compte_cree: "2020-01-02" });
assert.equal(profileFromUserinfo({ ID: "0" }), null);
assert.equal(authConfig({ SSO_ISSUER: "https://x", SSO_CLIENT_ID: "c", PUBLIC_URL: "http://localhost:3000" }).enabled, true);
assert.equal(authConfig({ SSO_ISSUER: "https://x", SSO_CLIENT_ID: "c" }).enabled, false, "PUBLIC_URL requis");

// ---- id_token OIDC (RS256 / JWKS) ----
import { verifyIdToken } from "../src/jwt.js";
{
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" }] };
  const mk = (claims, alg = "RS256", key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg, kid: "k1" })).toString("base64url"), p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
  };
  const now = 1_800_000_000_000, base = { iss: "https://x", aud: "c", exp: now / 1000 + 600, nonce: "n" };
  const o = { jwks, issuer: "https://x", audience: "c", nonce: "n", now };
  assert.equal(verifyIdToken(mk(base), o).nonce, "n");
  assert.throws(() => verifyIdToken(mk({ ...base, iss: "https://autre" }), o), /émetteur/);
  assert.throws(() => verifyIdToken(mk({ ...base, aud: "autre" }), o), /audience/);
  assert.throws(() => verifyIdToken(mk({ ...base, exp: now / 1000 - 3600 }), o), /expiré/);
  assert.throws(() => verifyIdToken(mk(base), { ...o, nonce: "autre" }), /nonce/);
  assert.throws(() => verifyIdToken(mk(base, "RS256", crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey), o), /signature/);
  assert.throws(() => verifyIdToken(mk(base, "none"), o), /algorithme/);
}

// ---- sessions : expiration, cookie opaque, rotation ----
import { createSessionStore } from "../src/sessions.js";
{
  let t = 1_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-sess-"));
  const st = createSessionStore({ dir, ttlDays: 1, maxDays: 3, now: () => t });
  const { id } = st.create({ user: { sub: "wp:1" }, tokens: { access: "a", exp: 0 } });
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.readdirSync(dir).some((f) => f.includes(id)), false, "le nom de fichier ne révèle pas l'identifiant");
  assert.equal(st.get(id).user.sub, "wp:1");
  assert.equal(st.get("inconnu"), null);
  t += 23 * 3600_000; assert.ok(st.get(id), "expiration glissante : l'activité prolonge");
  t += 23 * 3600_000; assert.ok(st.get(id));
  const nid = st.rotate(id); assert.ok(nid && nid !== id); assert.equal(st.get(id), null, "ancien identifiant invalidé"); assert.ok(st.get(nid));
  const st2 = createSessionStore({ dir, ttlDays: 1, maxDays: 3, now: () => t });
  assert.ok(st2.get(nid), "persistée sur disque");
  t += 25 * 3600_000; assert.equal(st.get(nid), null, "expirée après inactivité");
  const { id: id2 } = st.create({ user: {}, tokens: {} });
  for (let i = 0; i < 4; i++) { t += 20 * 3600_000; st.get(id2); }
  assert.equal(st.get(id2), null, "durée de vie absolue");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- limites anonymes (compteurs seulement, aucun contenu) ----
import { userMessages, createAnonLimiter, LIMIT_MESSAGE, ANON_MAX_QUESTIONS, validVisitorId, newVisitorId } from "../src/anon.js";
assert.equal(ANON_MAX_QUESTIONS, 5);
assert.equal(userMessages([{ role: "user" }, { role: "assistant" }, { role: "user" }, "x", null]), 2);
assert.ok(validVisitorId(newVisitorId()) && newVisitorId().length === 22 && !validVisitorId("court") && !validVisitorId(undefined));
assert.ok(LIMIT_MESSAGE.includes("https://rejoindre.coworking-metz.fr/") && LIMIT_MESSAGE.includes("https://www.coworking-metz.fr/contact/#ouvrir-brevo") && !/\p{Extended_Pictographic}/u.test(LIMIT_MESSAGE));
{
  let t = Date.parse("2026-11-27T10:00:00Z");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mp-anon-")), "a.json");
  const mk = () => createAnonLimiter({ file: f, maxQuestions: 5, maxPerIp: 8, now: () => t });
  const l = mk(), hist = (n) => Array.from({ length: n }, () => ({ role: "user" }));
  const v = newVisitorId();
  for (let i = 1; i <= 5; i++) { assert.equal(l.allowed(v, "1.2.3.4", hist(i)), true, `question ${i}`); assert.equal(l.record(v, "1.2.3.4"), 5 - i); }
  assert.equal(l.allowed(v, "1.2.3.4", hist(1)), false, "6e refusée : compteur du cookie");
  assert.equal(l.limited(v, "9.9.9.9"), true, "limite atteinte : mémorisée par le cookie, quelle que soit l'IP");
  assert.equal(l.limited(newVisitorId(), "5.6.7.8"), false, "autre visiteur, autre IP : pas bloqué");
  assert.equal(l.limited(undefined, "5.6.7.8"), false, "sans cookie valide et IP vierge : pas bloqué");
  assert.equal(l.allowed(newVisitorId(), "5.6.7.8", hist(6)), false, "historique de 6 questions refusé");
  // contournement par suppression du cookie : plafond par IP
  const r = [];
  for (let i = 0; i < 5; i++) { const id = newVisitorId(); r.push(l.allowed(id, "1.2.3.4", hist(1))); if (r.at(-1)) l.record(id, "1.2.3.4"); }
  assert.deepEqual(r, [true, true, true, false, false], "8 questions par IP et par jour (5 déjà posées)");
  const id2 = newVisitorId(); assert.equal(l.allowed(id2, "5.6.7.8", hist(1)), true, "autre IP");
  l.record(id2, "5.6.7.8"); l.refund(id2, "5.6.7.8"); assert.equal(l.status(id2, "5.6.7.8").n, 0, "une erreur technique ne consomme pas de question");
  await new Promise((res) => setTimeout(res, 1200)); // écriture groupée du fichier de compteurs
  const raw = fs.readFileSync(f, "utf8");
  assert.ok(!raw.includes("1.2.3.4") && !raw.includes(v), "ni IP ni identifiant de visiteur en clair");
  assert.equal(mk().allowed(v, "9.9.9.9", hist(1)), false, "compteur persisté");
  t += 25 * 3600_000; assert.equal(l.allowed(v, "1.2.3.4", hist(1)), true, "visiteur et IP remis à zéro après 24 h");
}

// ---- PDF ----
import { cleanPdfMessages, conversationPdf, pdfSafe, inlineRuns, PDF_MAX_MESSAGES } from "../src/pdf.js";
assert.ok(cleanPdfMessages(null).error && cleanPdfMessages({ messages: [] }).error && cleanPdfMessages({ messages: "x" }).error);
assert.ok(cleanPdfMessages({ messages: [{ role: "system", content: "x" }] }).error, "rôle refusé");
assert.ok(cleanPdfMessages({ messages: [{ role: "user", content: 5 }] }).error);
assert.ok(cleanPdfMessages({ messages: Array.from({ length: PDF_MAX_MESSAGES + 1 }, () => ({ role: "user", content: "a" })) }).error, "40 messages maximum");
assert.equal(cleanPdfMessages({ messages: [{ role: "user", content: "a".repeat(20000) }] }).messages[0].content.length, 6000);
assert.equal(pdfSafe("Prix : 80 € – œuvre 😀 café\u202Fok"), "Prix : 80 € – œuvre café ok");
assert.deepEqual(inlineRuns("a **b** [c](https://x.fr/y) d").map((r) => r.t), ["a ", "b", " ", "c", " (https://x.fr/y)", " d"]);
{
  const pdf = await conversationPdf([{ role: "user", content: "Quels tarifs ? 😀" }, { role: "assistant", content: "Voici :\n- [Abonnement](https://www.coworking-metz.fr/boutique/) : **80 €**\n- œuvres – café" }]);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF"); assert.ok(pdf.length > 1024);
}

// ---- contexte du membre : minimisation ----
import { normalizeSummary, formatMember } from "../src/members.js";
{
  const n = normalizeSummary({ prenom: "Camille", email: "a@b.c", telephone: "0600000000", ID: 9, adherent: { a_jour: true, derniere_annee: 2026 }, presences: { jours_90: 31, total: 4 }, carnets: { solde: "x" }, indisponible: ["achats", "bidon"] });
  const txt = formatMember(n, "2026-11-27");
  assert.ok(txt.includes("Camille") && txt.includes("90 derniers jours : 31") && txt.includes("week-end (au moins 10 journées coworkées) : non"));
  assert.ok(!/a@b\.c|0600|\b9\b/.test(txt)); assert.ok(txt.includes("NON disponibles") && txt.includes("Solde de carnets") && txt.includes("Achats de la boutique") && txt.includes("section « achats »") && !txt.includes("bidon"));
  assert.ok(txt.includes("Maître de stage ou d'alternance (30 journées sur 90 jours) : condition remplie"));
}
{ // achats : 10 lignes au plus, le reste compté ; produits nettoyés ; catégories inconnues -> autre
  const achats = Array.from({ length: 14 }, (_, i) => ({ date: `2026-0${(i % 9) + 1}-05`, produit: `Produit ${i} <b>`, categorie: i ? "carnet" : "zzz", quantite: 1, montant_ttc: 10 }));
  const txt = formatMember(normalizeSummary({ prenom: "Camille", achats, achats_resume: { commandes: 14, total_ttc: 140, complet: false, plus_anciens: 3, par_categorie: { carnet: { quantite: 13, montant_ttc: 130 }, x: {} } } }), "2026-11-27");
  assert.equal(txt.split("\n").filter((l) => l.startsWith("- ")).length, 10);
  assert.ok(txt.includes("7 autre(s) achat(s) plus ancien(s)") && txt.includes("historique tronqué") && !txt.includes("<b>") && txt.includes("total 140 € TTC"));
  assert.ok(normalizeSummary({ achats: [{ produit: "P", categorie: "zzz" }] }).achats[0].categorie === "autre");
}
{ // sections nulles (endpoint partiel) : jamais d'exception, informations déclarées manquantes
  const n = normalizeSummary({ prenom: "Camille", adherent: null, abonnement: null, presences: null, statistiques: null, achats: null, nomade: null, droits: null, indisponible: ["presences", "achats"] });
  const txt = formatMember(n, "2026-11-27");
  assert.ok(txt.includes("Camille") && txt.includes("Droit de venir le week-end") && txt.includes("Achats de la boutique") && !/week-end \(au moins/.test(txt));
  assert.doesNotThrow(() => formatMember(normalizeSummary(null)));
  assert.doesNotThrow(() => formatMember(normalizeSummary("n'importe quoi")));
}
{ // repli : 500, timeout, JSON invalide -> identité de base, réessai après 30 s
  const { createMembers } = await import("../src/members.js");
  const session = { user: { nom: "Camille D.", statut: "coworker" } };
  let t = 0, calls = 0, mode = "500";
  const f = async () => { calls++; if (mode === "500") return { ok: false, status: 500 }; if (mode === "throw") throw new Error("timeout"); if (mode === "badjson") return { ok: true, json: async () => { throw new Error("x"); } }; return { ok: true, json: async () => ({ prenom: "Camille", presences: { jours_30: 2 } }) }; };
  const m = createMembers({ url: "http://x/y", fetchImpl: f, now: () => t });
  for (const md of ["500", "throw", "badjson"]) { mode = md; t += 60000; const txt = await m.contextFor("s" + md, session, async () => "tok"); assert.ok(txt.includes("Camille D.") && txt.includes("Statut approximatif du compte : coworker") && txt.includes("NON disponibles"), md); }
  mode = "500"; const c0 = calls; await m.contextFor("sx", session, async () => "tok"); await m.contextFor("sx", session, async () => "tok"); assert.equal(calls, c0 + 1, "échec mis en cache brièvement");
  mode = "ok"; t += 31000; assert.ok((await m.contextFor("sx", session, async () => "tok")).includes("sur les 30 derniers jours : 2"), "réessai après 30 s");
  const c1 = calls; t += 4 * 60000; await m.contextFor("sx", session, async () => "tok"); assert.equal(calls, c1, "succès mis en cache 5 min");
  t += 2 * 60000; mode = "500"; await m.contextFor("sx", session, async () => "tok"); assert.equal(calls, c1 + 1);
}
// ---- outil mes_presences : historique mensuel complet / jours d'un mois (données fictives) ----
{
  const { formatPresences, createMembers } = await import("../src/members.js");
  const { toolDefsFor, execTool } = await import("../src/providers/common.js");
  const ans = Array.from({ length: 11 }, (_, i) => 2016 + i);
  const histo = Object.fromEntries(ans.map((a) => [a, Array.from({ length: 12 }, (_, m) => (a === 2016 && m < 2 ? null : a === 2026 && m > 10 ? null : (m * 3 + a) % 9 === 0 ? 0 : ((m * 3 + a) % 9) + (m === 4 ? 0.5 : 0)))]));
  const tot = Object.fromEntries(ans.map((a) => [a, histo[a].reduce((x, v) => x + (v ?? 0), 0)]));
  const RAW = { premiere_venue: "2016-03-02", total: 1060, total_par_annee: tot, historique_mensuel: histo, mis_a_jour: "2026-11-27T10:00:00+00:00", email: "x@y.z" };
  const txt = formatPresences(RAW);
  const lignes = txt.split("\n");
  assert.equal(lignes.length, 12, "une ligne d'introduction + une ligne par année");
  assert.ok(lignes[1].startsWith("2016 (total ") && lignes[1].includes("janv -, févr -, mars") && lignes[11].includes("nov ") && lignes[11].includes("déc -"), "avant la première venue / mois à venir : « - »");
  assert.ok(lignes.some((l) => l.startsWith("2019") && l.includes("mars 0,")), "0 = aucune venue");
  assert.ok(txt.includes("Première venue : 2016-03-02") && txt.includes("total : 1060") && txt.includes("mai ") && txt.includes(".5") && !txt.includes("x@y.z"));
  const tokens = Math.round(txt.length / 3.5);
  console.log(`  mes_presences, 11 années d'historique : ${txt.length} caractères, ≈ ${tokens} tokens`);
  assert.ok(tokens < 900, "résultat d'outil compact");
  assert.equal(formatPresences({ historique_mensuel: { "2020": [1, 2] } }), null, "année incomplète ignorée -> inutilisable");
  assert.equal(formatPresences(null), null); assert.equal(formatPresences("x"), null);
  // mois : jours validés, hors mois écartés
  const m = formatPresences({ mois: "2019-03", nb_jours: 2.5, jours: ["2019-03-04", "2019-04-01", "pas une date", "2019-03-12"], demi_journees: ["2019-03-12", "2019-05-05"] }, "2019-03");
  assert.equal(m, "Présences du mois 2019-03 : 2.5 journée(s) : 2019-03-04, 2019-03-12 ; demi-journées : 2019-03-12");
  assert.ok(formatPresences({ mois: "2019-03", nb_jours: 0, jours: [] }, "2019-03").includes("aucune venue"));
  assert.equal(formatPresences({ mois: "2019-04", jours: [] }, "2019-03"), null, "mois différent de celui demandé");

  // présence de l'outil : jamais déclaré sans memberTools
  assert.ok(!toolDefsFor(false).some((t) => t.name === "mes_presences") && toolDefsFor(true).some((t) => t.name === "mes_presences" && t.strict === false && !t.parameters.required));
  assert.equal((await execTool("mes_presences", {}, {})).ok, false); assert.equal((await execTool("mes_presences", {})).texte, "Outil inconnu.");

  // client : jeton de la session, URL, cache 60 s par mois, échecs, délai, format invalide
  let t = 0, calls = [], mode = "ok";
  const f = async (url, o) => {
    calls.push({ url, auth: o.headers.Authorization, timeout: !!o.signal });
    if (mode === "throw") throw new Error("timeout");
    if (mode === "500") return { ok: false, status: 500 };
    if (mode === "badjson") return { ok: true, json: async () => ({ n: 1 }) };
    const mois = new URL(url).searchParams.get("mois");
    return { ok: true, json: async () => (mois ? { mois, nb_jours: 1, jours: [`${mois}-04`] } : RAW) };
  };
  const mem = createMembers({ url: "http://x/me/summary", presencesUrl: "http://x/api/me/presences", fetchImpl: f, now: () => t });
  const tok = async () => "TOK1";
  let r = await mem.presencesFor("s1", tok); assert.ok(r.texte.startsWith("Historique") && calls[0].url === "http://x/api/me/presences" && calls[0].auth === "Bearer TOK1");
  r = await mem.presencesFor("s1", tok, "2019-03"); assert.equal(calls[1].url, "http://x/api/me/presences?mois=2019-03"); assert.ok(r.texte.includes("2019-03-04"));
  await mem.presencesFor("s1", tok, "2019-03"); await mem.presencesFor("s1", tok); assert.equal(calls.length, 2, "cache 60 s");
  await mem.presencesFor("s2", tok, "2019-03"); assert.equal(calls.length, 3, "cache propre à la session");
  t += 61000; await mem.presencesFor("s1", tok, "2019-03"); assert.equal(calls.length, 4, "expiré après 60 s");
  for (const bad of ["2019-3", "mars 2019", "2019-13", "2019-03-04", "../x", 201903, "", "2019-00"]) { const n = calls.length; r = await mem.presencesFor("s3", tok, bad); assert.ok(r.erreur && calls.length === n, `mois invalide ${bad}`); }
  for (const md of ["throw", "500", "badjson"]) { mode = md; t += 61000; r = await mem.presencesFor("s4" + md, tok, "2020-01"); assert.deepEqual(r, { indisponible: true }, md); }
  mode = "ok"; r = await mem.presencesFor("s5", async () => null, "2020-01"); assert.deepEqual(r, { indisponible: true }, "pas de jeton");
  r = await createMembers({ url: "http://x", fetchImpl: f }).presencesFor("s6", tok); assert.deepEqual(r, { indisponible: true }, "route non configurée");
  // résultat d'outil indisponible -> message sans fuite
  const e = await execTool("mes_presences", { mois: "2020-01" }, { memberTools: { mesPresences: async () => ({ indisponible: true }) } });
  assert.equal(e.ok, false); assert.ok(e.texte.includes("momentanément indisponible"));
}
{ // prompt : consigne de l'outil dans le bloc « membre » seulement
  const { memberPrompt } = await import("../src/prompt.js");
  const mp = memberPrompt("X");
  assert.ok(mp.includes("mes_presences") && mp.includes("mois=AAAA-MM") && mp.includes("Ne dis jamais que tu n'as que les 12 derniers mois") && mp.includes("coworking-metz.fr/mon-compte/presences/"));
  if (corpusPresent) assert.ok(!systemPrompt().includes("mes_presences"), "le prompt anonyme ignore l'outil");
}
{ // le contexte membre (me/summary) n'est pas alourdi : aucune ligne d'historique complet
  const txt = formatMember(normalizeSummary({ prenom: "Camille", presences: { total: 1060 }, historique_mensuel: { 2019: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, total_par_annee: { 2019: 78 } }), "2026-11-27");
  assert.ok(!txt.includes("2019") || txt.includes("Compte créé"), "historique mensuel ignoré dans le contexte");
  assert.ok(!/historique/i.test(txt));
}
console.log("tests hors ligne : OK");

// Plafond de dépense : le total du jour survit à un redémarrage (fichier de compteurs, sans texte).
{
  const { execFileSync } = await import("node:child_process");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mp-spend-")), "spend.json");
  const run = (code) => execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, SPEND_FILE: f, PRICE_INPUT_PER_M: "1", PRICE_OUTPUT_PER_M: "2", DAILY_BUDGET_USD: "3" }, cwd: process.cwd(), encoding: "utf8" });
  run(`import * as l from "./src/limits.js"; l.countQuestion(); l.addUsage({ input_tokens: 1000000, output_tokens: 500000 }); await new Promise((r) => setTimeout(r, 1300));`);
  const raw = fs.readFileSync(f, "utf8");
  assert.ok(JSON.parse(raw).usd > 1.9 && JSON.parse(raw).questions === 1 && !/[a-z]{12}/i.test(raw.replace(/"day"|"usd"|"questions"/g, "")), "fichier de compteurs sans texte");
  const out = JSON.parse(run(`import * as l from "./src/limits.js"; console.log(JSON.stringify({ ...l.publicStats(), depasse: l.budgetExceeded() }));`));
  assert.equal(out.questions, 1, "compteur de questions conservé après redémarrage");
  assert.ok(out.spend_usd >= 1.99 && out.spend_usd <= 2.01, "dépense du jour conservée après redémarrage");
  assert.equal(out.depasse, false);
}
console.log("plafond de dépense persistant : OK");
