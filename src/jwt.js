// Validation d'un id_token OIDC signé en RS256 (JWKS), avec node:crypto uniquement.
// Le SSO actuel du site (OAuth2 simple) n'émet pas d'id_token : ce module ne sert que si le fournisseur en envoie un.
import crypto from "node:crypto";

const b64 = (s) => Buffer.from(s, "base64url");
const json = (s) => JSON.parse(b64(s).toString("utf8"));

/**
 * @param {string} token  id_token compact
 * @param {{jwks: {keys: object[]}, issuer: string, audience: string, nonce?: string, now?: number, skew?: number}} o
 * @returns {object} les claims, ou lève une Error
 */
export function verifyIdToken(token, { jwks, issuer, audience, nonce, now = Date.now(), skew = 60 }) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw new Error("id_token mal formé");
  const [h, p, s] = parts;
  const header = json(h);
  if (header.alg !== "RS256") throw new Error("algorithme refusé"); // refuse « none » et HS256 (confusion de clé)
  const keys = (jwks?.keys ?? []).filter((k) => k.kty === "RSA" && (!k.use || k.use === "sig") && (!header.kid || k.kid === header.kid));
  if (!keys.length) throw new Error("clé de signature introuvable");
  const data = Buffer.from(`${h}.${p}`);
  const ok = keys.some((k) => {
    try { return crypto.verify("RSA-SHA256", data, crypto.createPublicKey({ key: k, format: "jwk" }), b64(s)); } catch { return false; }
  });
  if (!ok) throw new Error("signature invalide");
  const c = json(p);
  const t = Math.floor(now / 1000);
  if (c.iss !== issuer) throw new Error("émetteur inattendu");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(audience)) throw new Error("audience inattendue");
  if (typeof c.exp !== "number" || c.exp + skew < t) throw new Error("id_token expiré");
  if (typeof c.nbf === "number" && c.nbf - skew > t) throw new Error("id_token pas encore valide");
  if (nonce !== undefined && c.nonce !== nonce) throw new Error("nonce invalide");
  return c;
}
