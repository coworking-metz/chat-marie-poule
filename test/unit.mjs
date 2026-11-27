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
  const n = normalizeSummary({ prenom: "Camille", email: "a@b.c", telephone: "0600000000", ID: 9, adhesion: { a_jour: true, derniere_annee: 2026 }, frequentation: { jours_90: 31, total: 4 }, tickets: { solde: "x" } });
  const txt = formatMember(n, "2026-11-27");
  assert.ok(txt.includes("Camille") && txt.includes("90 derniers jours : 31") && txt.includes("week-end (au moins 10 journées coworkées) : non"));
  assert.ok(!/a@b\.c|0600|\b9\b/.test(txt)); assert.ok(txt.includes("NON disponibles") && txt.includes("Solde de tickets"));
}
console.log("tests hors ligne : OK");
