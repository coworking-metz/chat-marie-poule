// Connexion SSO : OAuth2 Authorization Code + PKCE (S256), client public (sans secret), en « backend for frontend ».
// Le navigateur ne voit jamais de jeton : il ne reçoit qu'un cookie de session opaque. Aucun jeton ni donnée de membre
// n'est journalisé.
import crypto from "node:crypto";
import { verifyIdToken } from "./jwt.js";
import { ROTATE_AFTER_MS } from "./sessions.js";

export const LOGIN_COOKIE = "mp_login";
export const SESSION_COOKIE = "mp_sid";
const LOGIN_TTL_S = 600;
const HTTP_TIMEOUT_MS = 8000;

// ---------- PKCE ----------
export const b64url = (buf) => Buffer.from(buf).toString("base64url");
/** code_verifier : 32 octets aléatoires -> 43 caractères (RFC 7636 : 43 à 128). */
export const newVerifier = () => b64url(crypto.randomBytes(32));
export const challengeFor = (verifier) => b64url(crypto.createHash("sha256").update(verifier).digest());

// ---------- Cookies ----------
export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie illisible : ignoré */ } }
  }
  return out;
}
export function serializeCookie(name, value, { maxAge, path = "/", secure = false } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (secure) c += "; Secure";
  return c;
}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- Configuration ----------
export function authConfig(env = process.env) {
  const issuer = (env.SSO_ISSUER || "").replace(/\/+$/, "");
  const publicUrl = (env.PUBLIC_URL || "").replace(/\/+$/, "");
  const cfg = {
    issuer,
    clientId: env.SSO_CLIENT_ID || "",
    publicUrl,
    scope: env.SSO_SCOPE || "basic",
    authorizeUrl: env.SSO_AUTHORIZE_URL || (issuer && `${issuer}/oauth/authorize/`),
    tokenUrl: env.SSO_TOKEN_URL || (issuer && `${issuer}/oauth/token/`),
    userinfoUrl: env.SSO_USERINFO_URL || (issuer && `${issuer}/oauth/me/`),
    revokeUrl: env.SSO_REVOKE_URL || (issuer && `${issuer}/oauth/revoke/`),
    jwksUrl: env.SSO_JWKS_URL || (issuer && `${issuer}/.well-known/keys/`),
    oidc: /^(1|on|true)$/i.test(env.SSO_OIDC || ""), // exiger et valider un id_token (le SSO actuel du site n'en émet pas)
    redirectUri: publicUrl && `${publicUrl}/auth/callback`,
    secure: publicUrl.startsWith("https://"),
  };
  cfg.enabled = Boolean(cfg.issuer && cfg.clientId && cfg.publicUrl);
  return cfg;
}

// Nettoyage d'un nom affiché : lettres, chiffres, espaces et ponctuation simple ; jamais d'adresse e-mail.
export function cleanName(s) {
  const v = String(s ?? "").normalize("NFC").replace(/[^\p{L}\p{N} '’.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return /@/.test(String(s ?? "")) ? "" : v;
}

const STATUTS = [["guest", "visiteur"], ["external", "externe"], ["inactive", "inactif"], ["coworker", "coworker"]];
/** Réponse de /oauth/me -> identité minimale conservée en session (pas d'e-mail, pas de date de naissance, pas d'avatar). */
export function profileFromUserinfo(me) {
  const id = Number.parseInt(me?.ID ?? me?.id ?? me?.sub, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const roles = Array.isArray(me.roles) ? me.roles.map(String) : [];
  const statut = STATUTS.find(([r]) => roles.includes(r))?.[1];
  const reg = /^\d{4}-\d{2}-\d{2}/.exec(String(me.user_registered ?? ""))?.[0];
  return { sub: `wp:${id}`, nom: cleanName(me.display_name), statut, compte_cree: reg };
}

// ---------- Fournisseur ----------
async function postForm(fetchImpl, url, params) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function tokensFrom(body, now) {
  if (typeof body?.access_token !== "string" || !body.access_token) throw new Error("réponse de jeton invalide");
  const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
  return { access: body.access_token, refresh: typeof body.refresh_token === "string" ? body.refresh_token : undefined, exp: now() + ttl * 1000 };
}

/**
 * @param {{cfg: ReturnType<typeof authConfig>, sessions: ReturnType<import("./sessions.js").createSessionStore>, fetchImpl?: typeof fetch, now?: () => number}} deps
 */
export function createAuth({ cfg, sessions, fetchImpl = fetch, now = Date.now }) {
  const refreshing = new Map(); // sid -> Promise (un seul rafraîchissement à la fois par session)
  // Connexions en cours, côté serveur, indexées par `state` (128 bits aléatoires), à usage unique, valables 10 minutes.
  // Aucune signature ni secret : le navigateur ne détient que le `state` (déjà visible dans l'URL) pour prouver que
  // c'est bien lui qui a lancé la connexion.
  const pending = new Map(); // state -> { verifier, nonce, exp }
  const MAX_PENDING = 5000;
  const takePending = (state) => {
    for (const [k, v] of pending) if (v.exp < now()) pending.delete(k);
    const p = typeof state === "string" ? pending.get(state) : undefined;
    if (p) pending.delete(state); // usage unique, succès ou échec
    return p && p.exp >= now() ? p : null;
  };

  function buildAuthorizeUrl({ state, challenge, nonce }) {
    const u = new URL(cfg.authorizeUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.clientId);
    u.searchParams.set("redirect_uri", cfg.redirectUri);
    u.searchParams.set("scope", cfg.scope);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    if (nonce) u.searchParams.set("nonce", nonce);
    return u.toString();
  }

  const cookieOpts = (extra) => ({ secure: cfg.secure, ...extra });

  /** Résout la session du cookie ; renseigne req.sid, req.session, req.user. */
  function attach(req, res, next) {
    req.sid = req.session = req.user = null;
    if (cfg.enabled) {
      const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const s = sid && sessions.get(sid);
      if (s) { req.sid = sid; req.session = s; req.user = s.user; }
      else if (sid) res.append("Set-Cookie", serializeCookie(SESSION_COOKIE, "", cookieOpts({ maxAge: 0 })));
    }
    next();
  }

  /** Jeton d'accès valable (rafraîchi si besoin). Renvoie null si la session n'est plus utilisable (elle est alors détruite). */
  async function accessToken(sid) {
    const s = sessions.get(sid);
    if (!s) return null;
    if (s.tokens.exp - 60_000 > now()) return s.tokens.access;
    if (!s.tokens.refresh) { sessions.destroy(sid); return null; }
    if (!refreshing.has(sid)) {
      refreshing.set(sid, (async () => {
        try {
          const r = await postForm(fetchImpl, cfg.tokenUrl, { grant_type: "refresh_token", refresh_token: s.tokens.refresh, client_id: cfg.clientId });
          if (!r.ok) {
            if (r.status === 400 || r.status === 401) sessions.destroy(sid); // jeton refusé : la session est terminée
            return null;
          }
          const t = tokensFrom(r.body, now);
          s.tokens = { access: t.access, refresh: t.refresh ?? s.tokens.refresh, exp: t.exp };
          sessions.save(sid);
          return t.access;
        } catch { return null; } // réseau indisponible : on garde la session, la personnalisation est simplement omise
        finally { refreshing.delete(sid); }
      })());
    }
    return refreshing.get(sid);
  }

  async function fetchUserinfo(token) {
    const res = await fetchImpl(cfg.userinfoUrl, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`userinfo ${res.status}`);
    return res.json();
  }

  async function fetchJwks() {
    const res = await fetchImpl(cfg.jwksUrl, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error("JWKS indisponible");
    return res.json();
  }

  // ----- routes -----
  function login(req, res) {
    if (!cfg.enabled) return res.status(503).type("text/plain").send("La connexion n'est pas configurée sur ce serveur.");
    if (pending.size >= MAX_PENDING) takePending(null);
    if (pending.size >= MAX_PENDING) return res.status(503).type("text/plain").send("Trop de connexions en cours, réessayez dans un instant.");
    const state = b64url(crypto.randomBytes(16)); // 128 bits
    const verifier = newVerifier();
    const nonce = cfg.oidc ? b64url(crypto.randomBytes(24)) : undefined;
    pending.set(state, { verifier, nonce, exp: now() + LOGIN_TTL_S * 1000 });
    res.append("Set-Cookie", serializeCookie(LOGIN_COOKIE, state, cookieOpts({ maxAge: LOGIN_TTL_S, path: "/auth" })));
    res.set("Cache-Control", "no-store");
    res.redirect(302, buildAuthorizeUrl({ state, challenge: challengeFor(verifier), nonce }));
  }

  async function callback(req, res) {
    res.set("Cache-Control", "no-store");
    const clearLogin = () => res.append("Set-Cookie", serializeCookie(LOGIN_COOKIE, "", cookieOpts({ maxAge: 0, path: "/auth" })));
    const fail = (why) => {
      clearLogin();
      console.error("[auth] connexion échouée :", why);
      res.redirect(302, "/?connexion=echec"); // la page est unique : retour toujours à l'accueil
    };
    if (!cfg.enabled) return res.status(503).type("text/plain").send("La connexion n'est pas configurée sur ce serveur.");
    const state = req.query.state;
    const tmp = takePending(state); // consommé dès maintenant
    // Le navigateur doit présenter le même state (cookie) : empêche de faire finir sa propre connexion à quelqu'un d'autre.
    if (!tmp || !same(parseCookies(req.headers.cookie)[LOGIN_COOKIE], state)) return fail("connexion inconnue, expirée ou déjà utilisée");
    if (req.query.error) { clearLogin(); return res.redirect(302, "/?connexion=refusee"); }
    if (typeof req.query.code !== "string" || !req.query.code || req.query.code.length > 2048) return fail("code absent");
    try {
      const r = await postForm(fetchImpl, cfg.tokenUrl, {
        grant_type: "authorization_code", code: req.query.code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, code_verifier: tmp.verifier,
      });
      if (!r.ok) return fail(`échange du code refusé (${r.status} ${String(r.body?.error ?? "").slice(0, 40)})`);
      const tokens = tokensFrom(r.body, now);
      if (cfg.oidc) {
        if (typeof r.body.id_token !== "string") return fail("id_token absent");
        verifyIdToken(r.body.id_token, { jwks: await fetchJwks(), issuer: cfg.issuer, audience: cfg.clientId, nonce: tmp.nonce, now: now() });
      }
      const user = profileFromUserinfo(await fetchUserinfo(tokens.access));
      if (!user) return fail("identité introuvable");
      // Nouvel identifiant aléatoire à chaque connexion (jamais celui d'un éventuel cookie préexistant : anti-fixation).
      const old = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (old) sessions.destroy(old);
      const { id } = sessions.create({ user, tokens });
      clearLogin();
      res.append("Set-Cookie", serializeCookie(SESSION_COOKIE, id, cookieOpts({ maxAge: Math.floor(sessions.ttlMs / 1000) })));
      res.redirect(302, "/");
    } catch (e) {
      fail(String(e?.message ?? e).slice(0, 80));
    }
  }

  // Protection CSRF sans secret : en-tête personnalisé (impossible en requête inter-sites sans pré-vérification CORS)
// et, s'il est présent, en-tête Origin identique à celui de PUBLIC_URL.
const csrfOk = (req) => {
    if (req.get("x-requested-with") !== "fetch") return false;
    const origin = req.get("origin");
    return !origin || origin === new URL(cfg.publicUrl || "http://invalide").origin;
  };

  function logout(req, res) {
    if (!csrfOk(req)) return res.status(403).json({ error: "Requête refusée." });
    const s = req.session;
    if (req.sid) sessions.destroy(req.sid);
    res.append("Set-Cookie", serializeCookie(SESSION_COOKIE, "", cookieOpts({ maxAge: 0 })));
    res.sendStatus(204);
    // Révocation côté SSO, au mieux : une erreur n'a aucune conséquence pour la personne.
    const tok = s?.tokens?.refresh || s?.tokens?.access;
    if (tok && cfg.revokeUrl) postForm(fetchImpl, cfg.revokeUrl, { token: tok, client_id: cfg.clientId }).catch(() => {});
  }

  function me(req, res) {
    res.set("Cache-Control", "no-store");
    if (req.sid && now() - (req.session.rotated ?? req.session.created) > ROTATE_AFTER_MS) {
      const nid = sessions.rotate(req.sid);
      if (nid) res.append("Set-Cookie", serializeCookie(SESSION_COOKIE, nid, cookieOpts({ maxAge: Math.floor(sessions.ttlMs / 1000) })));
    }
    const u = req.user;
    res.json({ sso: cfg.enabled, connecte: Boolean(u), ...(u ? { nom: u.nom || "Mon compte" } : {}) });
  }

  function mount(app) {
    app.get("/auth/login", login);
    app.get("/auth/callback", callback);
    app.post("/auth/logout", logout);
    app.get("/api/me", me);
  }

  return { attach, mount, accessToken, buildAuthorizeUrl, csrfOk, cfg };
}
