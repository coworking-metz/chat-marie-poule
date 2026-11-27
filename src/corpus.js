// Corpus documentaire : lecture des fiches de context/ et recherche plein texte simple.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "context");

// Fiches du corpus = tous les .md hors INDEX.md et hors noms commençant par « _ ».
function walk(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (e.name.endsWith(".md") && r !== "INDEX.md") out.push(r);
  }
  return out;
}

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

let cache = null;

export function loadCorpus() {
  const index = fs.readFileSync(path.join(ROOT, "INDEX.md"), "utf8");
  const fiches = new Map();
  for (const rel of walk(ROOT)) {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
    const titre = (raw.match(/^titre:\s*(.+)$/m) || [, rel])[1].trim();
    fiches.set(rel, { path: rel, titre, body, norm: stripAccents(`${titre}\n${body}`) });
  }
  cache = { index, fiches };
  return cache;
}

function corpus() {
  return cache ?? loadCorpus();
}

export function indexText() {
  return corpus().index;
}

export function nombreFiches() {
  return corpus().fiches.size;
}

/** lire_fiche : renvoie le texte d'une fiche (chemin relatif à context/, tel qu'écrit dans le catalogue). */
export function lireFiche(chemin) {
  const clean = String(chemin ?? "").trim().replace(/^`|`$/g, "").replace(/^context\//, "");
  const f = corpus().fiches.get(clean);
  if (!f) {
    return { ok: false, texte: `Fiche introuvable : « ${clean.slice(0, 120)} ». Utilise un chemin exact du catalogue (ex. themes/tarifs-et-abonnements.md) ou l'outil chercher.` };
  }
  return { ok: true, texte: `# ${f.titre}\n(fiche : ${f.path})\n\n${f.body}` };
}

/** chercher : classe les fiches par nombre d'occurrences des mots et renvoie des extraits. */
export function chercher(mots) {
  const termes = [...new Set(stripAccents(String(mots ?? "")).split(/[^a-z0-9€]+/).filter((t) => t.length >= 3))].slice(0, 8);
  if (!termes.length) return { ok: false, texte: "Aucun mot de recherche exploitable." };
  const scores = [];
  for (const f of corpus().fiches.values()) {
    let score = 0;
    for (const t of termes) {
      const n = f.norm.split(t).length - 1;
      score += Math.min(n, 10) + (stripAccents(f.titre).includes(t) ? 5 : 0);
    }
    if (score > 0) scores.push({ f, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const top = scores.slice(0, 5);
  if (!top.length) return { ok: true, texte: "Aucune fiche ne contient ces mots." };
  const lignes = top.map(({ f, score }) => {
    const lines = f.body.split("\n").filter((l) => termes.some((t) => stripAccents(l).includes(t)));
    const extraits = lines.slice(0, 3).map((l) => `  > ${l.trim().slice(0, 240)}`).join("\n");
    return `- ${f.path} — ${f.titre} (pertinence ${score})\n${extraits}`;
  });
  return { ok: true, texte: `Fiches les plus pertinentes (charge-les avec lire_fiche) :\n${lignes.join("\n")}` };
}
