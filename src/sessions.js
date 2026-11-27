// Sessions serveur des personnes connectées (SSO). Le navigateur ne reçoit qu'un identifiant aléatoire opaque ;
// les jetons d'accès et de rafraîchissement restent ici (mémoire + fichier JSON en 0600, dossier data/ gitignoré).
// Le nom du fichier est le SHA-256 de l'identifiant : lister le dossier ne révèle aucun cookie valable.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 3600 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_EVERY_MS = 10 * 60 * 1000; // l'expiration glissante n'écrit pas sur disque à chaque requête
export const ROTATE_AFTER_MS = 3600 * 1000;

/**
 * @param {{dir?: string, ttlDays?: number, maxDays?: number, now?: () => number}} opts
 * ttlDays : durée d'inactivité tolérée (glissante) ; maxDays : durée de vie absolue depuis la connexion.
 */
export function createSessionStore({ dir, ttlDays = 7, maxDays = 30, now = Date.now } = {}) {
  const DIR = path.resolve(ROOT, dir || process.env.SESSIONS_DIR || "data/sessions");
  const TTL = ttlDays * DAY;
  const MAX = maxDays * DAY;
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const cache = new Map(); // id -> session

  const file = (id) => path.join(DIR, `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
  const valid = (id) => typeof id === "string" && ID_RE.test(id);
  const expired = (s) => now() - s.seen > TTL || now() - s.created > MAX;

  function persist(id, s) {
    const tmp = `${file(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, file(id));
  }

  function get(id) {
    if (!valid(id)) return null;
    let s = cache.get(id);
    if (!s) {
      try { s = JSON.parse(fs.readFileSync(file(id), "utf8")); } catch { return null; }
      cache.set(id, s);
    }
    if (expired(s)) { destroy(id); return null; }
    if (now() - s.seen > TOUCH_EVERY_MS) { s.seen = now(); try { persist(id, s); } catch { /* disque indisponible : la session reste en mémoire */ } }
    return s;
  }

  /** Crée une session ; `data` = { user, tokens, ... }. Renvoie { id, session }. */
  function create(data) {
    const id = crypto.randomBytes(32).toString("base64url"); // 256 bits
    const s = { ...data, created: now(), seen: now() };
    cache.set(id, s);
    persist(id, s);
    return { id, session: s };
  }

  function save(id) {
    const s = cache.get(id);
    if (s) persist(id, s);
  }

  function destroy(id) {
    cache.delete(id);
    if (valid(id)) try { fs.unlinkSync(file(id)); } catch { /* déjà supprimée */ }
  }

  /** Change l'identifiant (anti-fixation) : l'ancien est invalidé immédiatement. */
  function rotate(id) {
    const s = get(id);
    if (!s) return null;
    const nid = crypto.randomBytes(32).toString("base64url");
    s.rotated = now();
    cache.set(nid, s);
    persist(nid, s);
    destroy(id);
    return nid;
  }

  function purge() {
    let n = 0;
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      try {
        const s = JSON.parse(fs.readFileSync(p, "utf8"));
        if (expired(s)) { fs.unlinkSync(p); n++; }
      } catch {
        try { if (f.endsWith(".tmp") ? now() - fs.statSync(p).mtimeMs > 3600_000 : true) { fs.unlinkSync(p); n++; } } catch { /* ignoré */ }
      }
    }
    for (const [id, s] of cache) if (expired(s)) cache.delete(id);
    return n;
  }

  return { get, create, save, destroy, rotate, purge, ttlMs: TTL, dir: DIR };
}
