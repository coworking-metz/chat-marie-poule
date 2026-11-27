// Tests de bout en bout hors ligne : serveur réel + faux SSO (OAuth2 PKCE) + faux service de synthèse du membre.
// L'appel au modèle est remplacé par test/stub-chat.mjs : aucun coût, aucune clé nécessaire.
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp-test-"));
// Données fictives (aucune donnée réelle) : contrat de deploy/wordpress/README.md
const FAKE_SUMMARY = { prenom: "Camille", membre_depuis: "2019-03-04", email: "ne-doit-pas-passer@example.org", telephone: "0600000000",
  adherent: { a_jour: true, derniere_annee: 2026, fin: "2026-12-31" },
  abonnement: { en_cours: true, debut: "2026-11-01", fin: "2026-12-15", duree_jours: 45, jours_restants: 18 },
  carnets: { solde: 3 }, tarif: { type: "reduit", reduit: true, resident_blida: false },
  nomade: { actif: false, dates_a_venir: [], derniere_date: null },
  presences: { jours_30: 8, jours_90: 21, total: 120, derniere_venue: "2026-11-25" },
  statistiques: { par_mois_12: [{ mois: "2026-10", jours: 9 }, { mois: "2026-11", jours: 8 }], moyenne_mensuelle_12: 6.5, par_jour_semaine: { lundi: 30, mardi: 40, mercredi: 20, jeudi: 20, vendredi: 10, samedi: 0, dimanche: 0 },
    mois_record: { mois: "2026-03", jours: 15 }, premiere_venue: "2019-04-02", total_jours: 120, semaines_consecutives: 3, types: { abonnement: 80, carnet: 40, nomade: 0 } },
  achats: [{ date: "2026-11-01", produit: "Abonnement 30 jours", categorie: "abonnement", quantite: 1, montant_ttc: 60, statut: "termine" }, { date: "2026-09-10", produit: "Carnet de 10 journées", categorie: "carnet", quantite: 1, montant_ttc: 80, statut: "termine" }],
  achats_resume: { commandes: 2, articles: 2, total_ttc: 140, par_categorie: { abonnement: { quantite: 1, montant_ttc: 60 }, carnet: { quantite: 1, montant_ttc: 80 } }, depuis: "2019-04-01", complet: true, plus_anciens: 0 },
  droits: { week_end: true, seuil_week_end: 10, jours_manquants_week_end: 0 }, indisponible: [], maj: "2026-11-27T10:00:00+00:00" };
const free = () => new Promise((r) => { const s = http.createServer().listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });
const SSO_PORT = await free(), PORT = await free();
const SSO = `http://127.0.0.1:${SSO_PORT}`, BASE = `http://localhost:${PORT}`;
const b64 = (b) => Buffer.from(b).toString("base64url");

// ---- Faux SSO ----
const codes = new Map();          // code -> { challenge, redirect }
const refreshes = new Set(["R1"]);
let tokenCalls = [];
let issued = 0;
const sso = http.createServer(async (req, res) => {
  const u = new URL(req.url, SSO);
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (u.pathname === "/oauth/authorize/") {
    const code = crypto.randomBytes(8).toString("hex");
    codes.set(code, { challenge: u.searchParams.get("code_challenge"), method: u.searchParams.get("code_challenge_method"), redirect: u.searchParams.get("redirect_uri") });
    const back = new URL(u.searchParams.get("redirect_uri")); back.searchParams.set("code", code); back.searchParams.set("state", u.searchParams.get("state"));
    res.writeHead(302, { Location: back.toString() }); return res.end();
  }
  if (u.pathname === "/oauth/token/") {
    let body = ""; for await (const c of req) body += c;
    const p = new URLSearchParams(body); tokenCalls.push(Object.fromEntries(p));
    assert.equal(p.get("client_secret"), null, "client public : jamais de secret");
    if (p.get("grant_type") === "authorization_code") {
      const c = codes.get(p.get("code")); codes.delete(p.get("code"));
      if (!c || c.method !== "S256" || b64(crypto.createHash("sha256").update(p.get("code_verifier") ?? "").digest()) !== c.challenge) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: `A${++issued}`, refresh_token: "R1", expires_in: 3600, token_type: "Bearer" });
    }
    if (p.get("grant_type") === "refresh_token" && refreshes.has(p.get("refresh_token"))) return send(200, { access_token: `A${++issued}`, refresh_token: "R1", expires_in: 3600 });
    return send(400, { error: "invalid_grant" });
  }
  if (u.pathname === "/oauth/me/") {
    if (!/^Bearer A\d+$/.test(req.headers.authorization ?? "")) return send(401, {});
    return send(200, { ID: "4242", user_login: "camille@example.org", display_name: "Camille D.", user_email: "camille@example.org", birthDate: "1990-01-01", roles: ["subscriber"], user_registered: "2019-03-04 10:00:00", avatar_url: "https://secure.gravatar.com/avatar/x" });
  }
  if (u.pathname === "/api-json-wp/cowo/v1/me/summary") {
    if (!/^Bearer A\d+$/.test(req.headers.authorization ?? "")) return send(401, {});
    return send(200, FAKE_SUMMARY);
  }
  if (u.pathname === "/oauth/revoke/") return send(200, {});
  send(404, {});
}).listen(SSO_PORT);

// ---- Serveur de l'application ----
const env = { ...process.env, PORT: String(PORT), CHAT_STUB: "test/stub-chat.mjs", SESSIONS_DIR: path.join(tmp, "sess"), ANON_FILE: path.join(tmp, "anon.json"), ANON_MAX_QUESTIONS_PER_IP_PER_DAY: "12",
  SSO_ISSUER: SSO, SSO_CLIENT_ID: "marie-poule", PUBLIC_URL: BASE, MEMBER_API_URL: `${SSO}/api-json-wp/cowo/v1/me/summary`,
  ANON_MAX_QUESTIONS: "5", RATE_LIMIT_PER_MIN: "1000", MODEL: "stub",
  MODEL_LABEL: "Modèle membre", MODEL_HOSTING: "hébergement membre", ANON_MODEL: "stub-anon", ANON_MODEL_LABEL: "Modèle anonyme" };
const child = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"], cwd: new URL("..", import.meta.url).pathname });
let logs = ""; child.stdout.on("data", (d) => (logs += d)); child.stderr.on("data", (d) => (logs += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

const jar = () => { const c = {}; return { c, set(res) { for (const h of res.headers.getSetCookie()) { const [kv] = h.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1)); if (h.includes("Max-Age=0")) delete c[k]; else c[k] = v; } }, get header() { return Object.entries(c).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "); } }; };
const call = async (j, p, opts = {}) => { const r = await fetch(BASE + p, { redirect: "manual", ...opts, headers: { cookie: j.header, ...(opts.headers ?? {}) } }); j.set(r); return r; };
const events = async (res) => [...(await res.text()).matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2])]);
const ask = (j, hist, message) => call(j, "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [...hist, { role: "user", content: message }] }) });
const pair = (q, a = "Réponse.") => [{ role: "user", content: q }, { role: "assistant", content: a }];

try {
  // ---------- Anonyme : 5 questions par cookie, puis refus sans appel au modèle ----------
  const a = jar();
  assert.deepEqual(await (await call(a, "/api/me")).json(), { sso: true, connecte: false });
  assert.equal((await call(a, "/api/conversations/AAAAAAAAAAAAAAAAAAAAAA")).status, 404, "plus de conversations conservées");
  assert.equal((await call(a, "/c/AAAAAAAAAAAAAAAAAAAAAA")).status, 404, "plus de permalink");
  let hist = [], last;
  for (let i = 1; i <= 5; i++) {
    const ev = await events(await ask(a, hist, `Question ${i}`));
    last = ev;
    assert.ok(!ev.some(([e]) => e === "limit"), `question ${i} acceptée`);
    assert.ok(!ev.some(([e]) => e === "meta"), "plus d'événement meta");
    // correctif « narration avant outil » : un reset précède la vraie réponse
    assert.ok(ev.findIndex(([e]) => e === "reset") < ev.findIndex(([e, d]) => e === "delta" && d.text === "Réponse."));
    hist = [...hist, ...pair(`Question ${i}`)];
  }
  assert.ok(a.c.mp_anon && a.c.mp_anon.length === 22, "cookie visiteur aléatoire");
  assert.equal(last.find(([e]) => e === "done")[1].restantes, 0, "après la 5e réponse : plus aucune question restante");
  const sixth = await events(await ask(a, hist, "Question 6"));
  assert.equal(sixth.length, 1); assert.equal(sixth[0][0], "limit");
  assert.ok(sixth[0][1].text.includes("rejoindre.coworking-metz.fr") && sixth[0][1].text.includes("#ouvrir-brevo"));
  // le blocage est mémorisé côté serveur par le cookie : l'interface le retrouve après un rechargement ou dans un autre onglet
  const st = await (await call(a, "/api/anon-status")).json();
  assert.equal(st.limite, true, "limite atteinte retrouvée via le cookie");
  assert.ok(st.message.includes("rejoindre.coworking-metz.fr"), "même message de renvoi, sans passer par le modèle");
  // « Nouvelle question » (historique vide) ne remet pas le compteur à zéro
  assert.equal((await events(await ask(a, [], "Autre sujet")))[0][0], "limit");
  // suppression du cookie : plafond par IP (12 par jour ; 5 déjà posées), historique falsifié à 6 questions refusé
  const nocookie = [];
  for (let i = 0; i < 9; i++) nocookie.push((await events(await ask(jar(), [], "Bonjour"))).some(([e]) => e === "limit"));
  assert.deepEqual(nocookie, [false, false, false, false, false, false, false, true, true], "12 questions par IP et par jour");
  assert.equal((await events(await ask(jar(), [...pair("1"), ...pair("2"), ...pair("3"), ...pair("4"), ...pair("5")], "6"))).some(([e]) => e === "limit"), true, "historique de 6 questions refusé");
  await new Promise((r) => setTimeout(r, 1300));
  const anonRaw = fs.readFileSync(path.join(tmp, "anon.json"), "utf8");
  assert.ok(!anonRaw.includes("127.0.0.1") && !anonRaw.includes("::1") && !anonRaw.includes(a.c.mp_anon) && !/Question|Bonjour/.test(anonRaw), "compteurs seulement : ni IP, ni identifiant, ni texte");
  assert.equal((await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "x", message: "ancien format" }) })).status, 400, "l'ancien mode { id, message } n'existe plus");

  // ---------- Connexion SSO (PKCE) ----------
  const j = jar();
  assert.equal((await call(j, "/auth/login?retour=https://evil.example")).status, 302);
  // cookie de connexion : le state seul, httpOnly
  const loginRes = await call(jar(), "/auth/login");
  assert.match(loginRes.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);
  const j2 = jar();
  const r1 = await call(j2, "/auth/login");
  const authUrl = new URL(r1.headers.get("location"));
  assert.equal(authUrl.origin + authUrl.pathname, `${SSO}/oauth/authorize/`);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("redirect_uri"), `${BASE}/auth/callback`);
  assert.equal(authUrl.searchParams.get("client_id"), "marie-poule");
  // state inconnu / falsifié refusé, sans échange de code
  tokenCalls = [];
  const bad = await call(j2, `/auth/callback?code=zzz&state=faux`);
  assert.match(bad.headers.get("location"), /connexion=echec/); assert.equal(tokenCalls.length, 0);
  // le state est à usage unique : même un state valide est consommé par un callback raté (ici : cookie absent)
  const st1 = authUrl.searchParams.get("state");
  assert.match((await call(jar(), `/auth/callback?code=zzz&state=${st1}`)).headers.get("location"), /echec/);
  assert.match((await call(j2, `/auth/callback?code=zzz&state=${st1}`)).headers.get("location"), /echec/); assert.equal(tokenCalls.length, 0, "state déjà consommé");
  // parcours normal (nouveau cookie de connexion)
  const j3 = jar(); const r2 = await call(j3, "/auth/login");
  const au = await fetch(r2.headers.get("location"), { redirect: "manual" });
  const cb = await call(j3, new URL(au.headers.get("location")).pathname + new URL(au.headers.get("location")).search);
  assert.equal(cb.status, 302); assert.equal(cb.headers.get("location"), "/");
  assert.equal(tokenCalls.length, 1);
  assert.match((await call(j3, new URL(au.headers.get("location")).pathname + new URL(au.headers.get("location")).search)).headers.get("location"), /echec/, "code et state ne servent qu'une fois");
  assert.equal(tokenCalls.length, 1); assert.ok(tokenCalls[0].code_verifier.length >= 43 && !("client_secret" in tokenCalls[0]));
  assert.match(cb.headers.getSetCookie().find((c) => c.startsWith("mp_sid=")), /HttpOnly; SameSite=Lax/);
  const me = await (await call(j3, "/api/me")).json();
  assert.deepEqual(me, { sso: true, connecte: true, nom: "Camille D." });
  // profils : pied de page et routage selon la session (membre connecté -> profil membre ; sinon profil anonyme)
  assert.deepEqual(await (await call(j3, "/api/config")).json(), { model: "Modèle membre", hosting: "hébergement membre" });
  assert.deepEqual(await (await call(jar(), "/api/config")).json(), { model: "Modèle anonyme", hosting: null }, "pas de mention d'hébergement sans ANON_MODEL_HOSTING");
  const health = await (await call(jar(), "/api/health")).json();
  assert.deepEqual(health.profils, { membre: { provider: "anthropic", model: "stub" }, anonyme: { provider: "anthropic", model: "stub-anon" }, anonyme_distinct: true });
  assert.ok(!JSON.stringify(health).match(/key|token|cle/i), "aucune clé dans /api/health");
  assert.ok((await events(await ask(j3, [], "PROFIL?"))).some(([e, d]) => e === "delta" && d.text === "connected=true"));
  assert.ok(!JSON.stringify(me).includes("example.org"));
  // ---------- Connecté : plus de limite, contexte transmis, rien de conservé ----------
  let ctxText = "", h = [];
  for (let i = 1; i <= 7; i++) {
    const ev = await events(await ask(j3, h, `Q${i}`));
    assert.ok(!ev.some(([e]) => e === "limit"), "connecté : pas de limite à 5");
    ctxText = ev.filter(([e]) => e === "delta").map(([, d]) => d.text).join("");
    h = [...h, ...pair(`Q${i}`)].slice(-10);
  }
  assert.ok(ctxText.includes("Camille") && ctxText.includes("Journées de présence sur les 90 derniers jours : 21") && ctxText.includes("décembre 2026"));
  assert.ok(ctxText.includes("Abonnement 30 jours – 60 €") && ctxText.includes("Moyenne mensuelle sur 12 mois : 6,5") && ctxText.includes("Tarif : réduit") && ctxText.includes("Régularité : 3 semaine"));
  assert.ok(!/0600000000|ne-doit-pas-passer/.test(ctxText));
  assert.ok(!/example\.org|1990|4242|Bearer/.test(ctxText), "pas d'e-mail, de date de naissance ni d'identifiant dans le contexte");
  assert.ok(ctxText.includes("donnees_personne_connectee") && ctxText.includes("UNIQUEMENT la personne"));
  assert.equal(fs.existsSync(path.join(tmp, "conv")), false, "aucun dossier de conversations");

  // ---------- PDF ----------
  const pdfRes = await call(a, "/api/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [...pair("Quels tarifs ? é€"), ...pair("Merci", "- **80 €** [lien](https://www.coworking-metz.fr/)")] }) });
  assert.equal(pdfRes.status, 200); assert.equal(pdfRes.headers.get("content-type"), "application/pdf");
  assert.match(pdfRes.headers.get("content-disposition"), /^attachment; filename="conversation-marie-poule-\d{4}-\d{2}-\d{2}\.pdf"$/);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 4).toString(), "%PDF"); assert.ok(pdfBuf.length > 1024);
  for (const body of ["{}", JSON.stringify({ messages: [{ role: "system", content: "x" }] }), JSON.stringify({ messages: Array.from({ length: 41 }, () => ({ role: "user", content: "a" })) })])
    assert.equal((await call(a, "/api/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 400);
  assert.equal((await call(a, "/api/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: "pas du json" })).status, 400);

  // ---------- Fichiers de session : pas de jeton côté navigateur, fichiers 0600 ----------
  const sdir = path.join(tmp, "sess"); const files = fs.readdirSync(sdir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 1); for (const f of files) assert.equal(fs.statSync(path.join(sdir, f)).mode & 0o077, 0);
  const sid = j3.c.mp_sid; assert.ok(sid && !files.some((f) => f.includes(sid)));

  // ---------- Déconnexion ----------
  assert.equal((await call(j3, "/auth/logout", { method: "POST" })).status, 403, "logout sans en-tête refusé");
  assert.equal((await call(j3, "/auth/logout", { method: "POST", headers: { "X-Requested-With": "fetch", Origin: "https://evil.example" } })).status, 403, "Origin étranger refusé");
  assert.equal((await call(jar(), "/api/me", { headers: { cookie: "mp_sid=" + "A".repeat(43) } })).status, 200);
  assert.equal((await (await call(jar(), "/api/me", { headers: { cookie: "mp_sid=" + "A".repeat(43) } })).json()).connecte, false, "session inconnue refusée");
  assert.equal((await call(j3, "/auth/logout", { method: "POST", headers: { "X-Requested-With": "fetch" } })).status, 204);
  assert.equal((await (await call(j3, "/api/me")).json()).connecte, false);
  assert.equal((await call(jar(), "/api/me")).status, 200);
  const old = jar(); old.c.mp_sid = sid; assert.equal((await (await call(old, "/api/me")).json()).connecte, false, "session détruite côté serveur");

  // journaux : aucun jeton ni contenu de contexte
  assert.ok(!logs.includes("Camille") && !logs.includes("R1"), "aucune donnée personnelle dans les journaux");
  console.log("tests serveur / SSO : OK");
} finally {
  child.kill(); sso.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
